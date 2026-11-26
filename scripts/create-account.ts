import { randomUUID } from "node:crypto";
import { loadConfig } from "../server/config.ts";
import { openDatabase } from "../server/db.ts";
import { hashPassword } from "../server/passwords.ts";
import { registerInput } from "../shared/validation.ts";
const role = process.argv[2] || 'member';
if (!['member', 'staff'].includes(role)) throw new Error('Choose member or staff as the account role.');
const input = registerInput.parse({
    name: process.env.ACCOUNT_NAME,
    email: process.env.ACCOUNT_EMAIL,
    password: process.env.ACCOUNT_PASSWORD
});
const db = await openDatabase(loadConfig());
try {
    const result = await db.query(
        `INSERT INTO users (id,name,email,password_hash,role) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (email) DO NOTHING RETURNING id`,
        [randomUUID(), input.name, input.email, await hashPassword(input.password), role]
    );
    if (!result.rows.length) throw new Error(`An account already uses this email. No role or password was changed.`);
    console.log(`${role === 'staff' ? 'Staff' : 'Member' } account created. Clear ACCOUNT_PASSWORD from your shell environment.`);
} finally {
    await db.close();
}