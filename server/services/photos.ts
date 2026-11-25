import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Database, Sql } from '../db.ts';
import type { Photo, User } from '../../shared/types.ts';
import { fail, MAX_PHOTOS, MAX_UPLOAD_BYTES } from '../../shared/domain.ts';
import { assertIssueAccess } from './issues.ts';
import { event, lockEquipment } from './common.ts';

export function photoPath(dataDir: string, id: string): string {
  return path.join(dataDir, 'uploads', `${id}.webp`);
}

async function authorizeUpload(
  tx: Sql,
  user: User,
  equipmentId: string,
  issueId?: string,
): Promise<void> {
  if (issueId) {
    const issue = await assertIssueAccess(tx, user, issueId, true);
    if (issue.equipment_id !== equipmentId)
      fail(404, 'NOT_FOUND', 'Condition report was not found.');
  } else if (user.role !== 'staff')
    fail(403, 'STAFF_REQUIRED', 'Only staff can add catalog photos.');
}

export async function uploadPhoto(
  db: Database,
  dataDir: string,
  user: User,
  equipmentId: string,
  issueId: string | undefined,
  file: Express.Multer.File | undefined,
  uploadId: string,
): Promise<{ id: string }> {
  if (!file || file.size === 0) fail(422, 'FILE_REQUIRED', 'Choose a photo to upload.');
  if (file.size > MAX_UPLOAD_BYTES)
    fail(413, 'FILE_TOO_LARGE', 'Photos must be no larger than 8 MiB.');
  await authorizeUpload(db, user, equipmentId, issueId);
  let image: Buffer;
  try {
    const metadata = await sharp(file.buffer, {
      limitInputPixels: 40_000_000,
      animated: false,
    }).metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format || '') || (metadata.pages || 1) > 1) {
      fail(415, 'IMAGE_FORMAT', 'Use a still JPEG, PNG, or WebP photo.');
    }
    image = await sharp(file.buffer, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error) throw error;
    fail(415, 'INVALID_IMAGE', 'This file could not be read as a supported image.');
  }
  const sourceHash = createHash('sha256').update(file.buffer).digest('hex');
  const id = randomUUID();
  let savedId: string = id;
  await mkdir(path.join(dataDir, 'uploads'), { recursive: true });
  const destination = photoPath(dataDir, id);
  await writeFile(destination, image, { flag: 'wx' });
  try {
    await db.transaction(async (tx) => {
      await lockEquipment(tx, equipmentId);
      await authorizeUpload(tx, user, equipmentId, issueId);
      const previous = await tx.query<Photo & { source_hash: string }>(
        'SELECT * FROM photos WHERE uploaded_by=$1 AND upload_request_id=$2',
        [user.id, uploadId],
      );
      if (previous.rows[0]) {
        const photo = previous.rows[0];
        if (
          photo.equipment_id !== equipmentId ||
          photo.issue_id !== (issueId || null) ||
          photo.source_hash !== sourceHash
        ) {
          fail(409, 'REQUEST_REUSED', 'This upload ID was used for another photo.');
        }
        savedId = photo.id;
        return;
      }
      const { rows } = await tx.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM photos
        WHERE equipment_id=$1 AND issue_id IS NOT DISTINCT FROM $2::uuid`,
        [equipmentId, issueId || null],
      );
      if (rows[0].count >= MAX_PHOTOS)
        fail(
          409,
          'PHOTO_LIMIT',
          `Keep up to ${MAX_PHOTOS} photos for this item or condition report.`,
        );
      await tx.query(
        'INSERT INTO photos (id,equipment_id,issue_id,uploaded_by,upload_request_id,source_hash) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, equipmentId, issueId || null, user.id, uploadId, sourceHash],
      );
      await event(tx, user.id, equipmentId, 'photo_added', {
        photoId: id,
        issueId: issueId || null,
      });
    });
  } catch (error) {
    await unlink(destination).catch(() => {});
    throw error;
  }
  if (savedId !== id) await unlink(destination).catch(() => {});
  return { id: savedId };
}

export async function authorizePhoto(db: Database, user: User, id: string): Promise<Photo> {
  const { rows } = await db.query<Photo>(
    'SELECT id,equipment_id,issue_id,created_at FROM photos WHERE id=$1',
    [id],
  );
  const photo = rows[0];
  if (!photo) fail(404, 'NOT_FOUND', 'Photo was not found.');
  if (photo.issue_id) await assertIssueAccess(db, user, photo.issue_id);
  return photo;
}

export async function removeCatalogPhoto(
  db: Database,
  dataDir: string,
  user: User,
  id: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const found = await tx.query<Photo>('SELECT * FROM photos WHERE id=$1', [id]);
    const photo = found.rows[0];
    if (!photo || photo.issue_id) fail(404, 'NOT_FOUND', 'Catalog photo was not found.');
    await lockEquipment(tx, photo.equipment_id);
    await tx.query('DELETE FROM photos WHERE id=$1', [id]);
    await event(tx, user.id, photo.equipment_id, 'photo_removed', { photoId: id });
  });
  // The reference is gone, so a failed unlink leaves a file for cleanup, not an accessible photo.
  await unlink(photoPath(dataDir, id)).catch(() => {});
}

export async function requirePhotoFile(dataDir: string, id: string): Promise<string> {
  const file = photoPath(dataDir, id);
  try {
    await stat(file);
  } catch {
    fail(404, 'FILE_UNAVAILABLE', 'This photo is unavailable. Contact staff.');
  }
  return file;
}
