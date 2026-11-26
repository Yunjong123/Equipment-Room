import { randomUUID } from 'node:crypto';
import type { Database } from './db.ts';
import { hashPassword } from './passwords.ts';
import { addDays, clubToday } from '../shared/domain.ts';
import type { Config } from './config.ts';

export const DEMO_PASSWORD = 'DemoRoom2026!';
const items = [
  [
    'CAM-01',
    'Mirrorless camera kit',
    'camera',
    'Camera body, standard zoom lens, battery, charger, and shoulder bag.'
  ],
  [
    'CAM-02',
    'Mirrorless camera kit',
    'camera',
    'Second camera kit for interviews and small events.'
  ],
  [
    'CAM-03',
    'Action camera',
    'camera',
    'Compact action camera with two batteries and a mounting kit.'
  ],
  ['CAM-04', 'Document camera', 'camera', 'USB document camera for demonstrations and workshops.'],
  [
    'AUD-01',
    'Wireless microphone kit',
    'audio',
    'Two transmitters, one receiver, and a charging case.'
  ],
  ['AUD-02', 'Wireless microphone kit', 'audio', 'Second two-person wireless microphone kit.'],
  ['AUD-03', 'Shotgun microphone', 'audio', 'Directional microphone with wind cover and cable.'],
  [
    'AUD-04',
    'Portable audio recorder',
    'audio',
    'Four-input field recorder with SD card and adapter.'
  ],
  [
    'AUD-05',
    'Monitoring headphones',
    'audio',
    'Closed-back headphones with a quarter-inch adapter.'
  ],
  ['LGT-01', 'LED panel kit', 'lighting', 'Bi-color LED panel, stand, power adapter, and diffuser.'],
  ['LGT-02', 'LED panel kit', 'lighting', 'Matching LED panel kit for a two-light setup.'],
  ['LGT-03', 'Portable tube light', 'lighting', 'Rechargeable tube light with a compact stand.'],
  ['LGT-04', 'Reflector kit', 'lighting', 'Foldable five-in-one reflector and carrying case.'],
  ['SUP-01', 'Video tripod', 'support', 'Fluid-head tripod with a quick-release plate.'],
  ['SUP-02', 'Video tripod', 'support', 'Second fluid-head tripod with a quick-release plate.'],
  ['SUP-03', 'Phone stabilizer', 'support', 'Three-axis stabilizer with charging cable.'],
  ['SUP-04', 'Boom stand', 'support', 'Microphone boom stand with clip and counterweight.'],
  [
    'PRJ-01',
    'Portable projector',
    'projector',
    '1080p projector with remote, HDMI cable, and power lead.'
  ],
  ['PRJ-02', 'Portable projector', 'projector', 'Second projector for meetings and screenings.'],
  ['ACC-01', 'Presentation adapter kit', 'accessory', 'USB-C and HDMI adapters in a labeled pouch.'],
] as const;

export async function seedDemo(db: Database, config: Pick<Config, 'demo' | 'production' | 'timeZone'>): Promise<void> {
  if (!config.demo || config.production) throw new Error('Demo seeding is allowed only in demo mode outside production.');
  const password = await hashPassword(DEMO_PASSWORD);
  const today = clubToday(config.timeZone);
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(72490312)');
    const populated = await tx.query('SELECT id FROM users LIMIT 1');
    if (populated.rows.length) return;
    const member = randomUUID();
    const staff = randomUUID();
    for (const user of [
      { id: member, email: 'jordan@example.com', name: 'Jordan Lee', role: 'member' },
      { id: randomUUID(), email: 'taylor@example.com', name: 'Taylor Morgan', role: 'member' },
      { id: staff, email: 'casey@example.com', name: 'Casey Brooks', role: 'staff' },
    ]) await tx.query(
      'INSERT INTO users (id,email,name,role,password_hash) VALUES ($1,$2,$3,$4,$5)',
      [user.id, user.email, user.name, user.role, password]
    );
    const equipment = new Map<string, string>();
    for (const [tag, name, category, description] of items) {
      const id = randomUUID();
      equipment.set(tag, id);
      await tx.query(
        `INSERT INTO equipment (id,asset_tag,name,category,description,location,condition,condition_notes)
        VALUES ($1,$2,$3,$4,$5,'Media room, front desk',$6,$7)`,
        [
          id,
          tag,
          name,
          category,
          description,
          tag === 'PRJ-02' ? 'maintenance' : 'ready',
          tag === 'PRJ-02' ? 'Power connector inspection.' : ''
        ]
      );
    }
    for (const sample of [
      {
        tag: 'CAM-01',
        start: today,
        end: addDays(today, 2),
        status: 'reserved',
        purpose: 'Student interview project'
      },
      {
        tag: 'AUD-04',
        start: addDays(today, -3),
        end: addDays(today, -1),
        status: 'checked_out',
        purpose: 'Community event recording'
      },
    ]) {
      const id = randomUUID();
      const asset = equipment.get(sample.tag)!;
      await tx.query(
        `INSERT INTO bookings (id,equipment_id,user_id,start_date,end_date,purpose,request_id,status,checked_out_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          asset,
          member,
          sample.start,
          sample.end,
          sample.purpose,
          randomUUID(),
          sample.status,
          sample.status === 'checked_out' ? `${sample.start}T15:00:00Z` : null
        ]
      );
      for (let day = sample.start; day <= sample.end; day = addDays(day, 1)) {
        await tx.query('INSERT INTO booking_days (equipment_id,day,booking_id) VALUES ($1,$2,$3)', [asset, day, id]);
      }
      await tx.query(
        `INSERT INTO audit_events (id,equipment_id,booking_id,actor_id,action,details)
        VALUES ($1,$2,$3,$4,'demo_record_created','{}')`,
        [randomUUID(), asset, id, staff]
      );
    }
  });
}
