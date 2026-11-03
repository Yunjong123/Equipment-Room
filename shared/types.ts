export type Role = 'member' | 'staff';
export type EquipmentCondition = 'ready' | 'maintenance' | 'retired';
export type BookingStatus = 'reserved' | 'checked_out' | 'returned' | 'cancelled' | 'no_show';
export type Category = 'camera' | 'audio' | 'lighting' | 'support' | 'projector' | 'accessory';
export type User = { id: string; email: string; name: string; role: Role };
export type Equipment = {
  id: string;
  asset_tag: string;
  name: string;
  category: Category;
  description: string;
  location: string;
  condition: EquipmentCondition;
  condition_notes: string;
  version: number;
  cover_photo_id: string | null;
  open_issues: number;
  checked_out: boolean;
  overdue: boolean;
  available?: boolean;
  created_at: string;
};
export type Booking = {
  id: string;
  equipment_id: string;
  user_id: string;
  start_date: string;
  end_date: string;
  purpose: string;
  status: BookingStatus;
  version: number;
  checked_out_at: string | null;
  returned_at: string | null;
  cancellation_reason: string | null;
  created_at: string;
  equipment_name: string;
  asset_tag: string;
  equipment_condition: EquipmentCondition;
  borrower_name: string;
  borrower_email: string;
  overdue: boolean;
  blocked: boolean;
};
export type Photo = {
  id: string;
  equipment_id: string;
  issue_id: string | null;
  created_at: string
};
export type Issue = {
  id: string;
  equipment_id: string;
  booking_id: string | null;
  reporter_id: string;
  reporter_name: string;
  equipment_name: string;
  asset_tag: string;
  description: string;
  status: 'open' | 'resolved';
  resolution: string | null;
  version: number;
  created_at: string;
  resolved_at: string | null;
  photos: Photo[];
};
export type AuditEvent = {
  id: string;
  action: string;
  actor_name: string;
  details: Record<string, unknown>;
  created_at: string;
};
export type ClubSettings = {
  name: string;
  timeZone: string;
  today: string;
  maxLoanDays: number;
  bookingHorizonDays: number;
  demo: boolean;
  allowSignup: boolean;
};
export type EquipmentDetails = {
  equipment: Equipment;
  photos: Photo[];
  reservedDates: { start_date: string; end_date: string }[];
  events: AuditEvent[];
};
export type BookingDetails = { booking: Booking; events: AuditEvent[] };
export type SessionInfo = { user: User | null; csrfToken: string };
