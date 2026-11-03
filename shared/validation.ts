import { z } from 'zod';
import { CATEGORIES, isDate } from './domain.ts';

const text = (max: number) => z.string().trim().min(1).max(max);
export const uuid = z.string().uuid();
export const date = z.string().refine(isDate, 'Use a valid date.');
export const version = z.number().int().positive();
export const loginInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
}).strict();
export const registerInput = loginInput.extend({
  name: text(80),
  password: z.string().min(12, 'Use at least 12 characters.').max(128),
});
export const equipmentInput = z.object({
  assetTag: text(30).regex(/^[A-Z0-9][A-Z0-9-]*$/, 'Use uppercase letters, numbers, and hyphens.'),
  name: text(100),
  category: z.enum(CATEGORIES),
  description: z.string().trim().max(2000),
  location: text(120),
  condition: z.enum(['ready', 'maintenance', 'retired']),
  conditionNotes: z.string().trim().max(1000),
}).strict().refine(
  (value) => value.condition === 'ready' || value.conditionNotes.length > 0,
  {
    message: 'Add a reason for maintenance or retirement.', path: ['conditionNotes'],
  }
);
export const equipmentUpdateInput = z.object({
  ...equipmentInput.shape,
  expectedVersion: version,
}).strict().refine(
  (value) => value.condition === 'ready' || value.conditionNotes.length > 0,
  {
    message: 'Add a reason for maintenance or retirement.', path: ['conditionNotes'],
  }
);
export const reservationInput = z.object({
  equipmentId: uuid, startDate: date, endDate: date, purpose: text(500), requestId: uuid,
}).strict();
export const actionInput = z.object({
  expectedVersion: version,
  notes: z.string().trim().max(1000).default(''),
  returnCondition: z.enum(['ready', 'maintenance']).optional(),
}).strict();
export const issueInput = z.object({
  equipmentId: uuid, bookingId: uuid.optional(), description: text(2000), requestId: uuid,
}).strict();
export const resolveInput = z.object({ expectedVersion: version, resolution: text(2000) }).strict();
