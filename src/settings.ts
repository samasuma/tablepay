// Per-venue settings. Stored as JSON on restaurants.settings; missing keys fall back to DEFAULTS,
// so venues created before a setting existed keep today's behaviour.

export type PayMethod = "mpesa" | "pesapal" | "card" | "cash";

export type VenueSettings = {
  /** Who can add orders in TablePay: guests from their phone, staff only, or nobody (menu / pay only). */
  ordering: "guest" | "staff" | "off";
  /** Guests can call a waiter, ask for the bill, water, or send a note. */
  waiterCalls: boolean;
  /** Guests can see the shared bill and pay from their phone. */
  payAtTable: boolean;
  /** Staff tap "Entered in POS" once they have keyed an order into the venue's own POS. */
  posHandoff: boolean;
  /** Minutes before an order not yet entered in the POS is flagged on the board. */
  posReminderMin: number;
  /** Staff confirm the total against the POS before guests can pay. */
  confirmBill: boolean;
  /** Which ways guests may pay their share. */
  payMethods: Record<PayMethod, boolean>;
};

export const DEFAULTS: VenueSettings = {
  ordering: "guest",
  waiterCalls: true,
  payAtTable: true,
  posHandoff: false,
  posReminderMin: 3,
  confirmBill: false,
  payMethods: { mpesa: true, pesapal: false, card: false, cash: false },
};

export function readSettings(json: string | null | undefined): VenueSettings {
  let raw: any = {};
  try { raw = json ? JSON.parse(json) : {}; } catch { raw = {}; }
  return {
    ...DEFAULTS,
    ...pick(raw),
    payMethods: { ...DEFAULTS.payMethods, ...(raw.payMethods || {}) },
  };
}

/** Validate a partial update from the admin screen and merge it onto the current settings. */
export function mergeSettings(current: VenueSettings, patch: any): VenueSettings {
  const next = { ...current, payMethods: { ...current.payMethods } };
  if (patch?.ordering !== undefined) {
    if (!["guest", "staff", "off"].includes(patch.ordering)) throw new Error("Ordering must be guest, staff or off");
    next.ordering = patch.ordering;
  }
  for (const k of ["waiterCalls", "payAtTable", "posHandoff", "confirmBill"] as const) {
    if (patch?.[k] !== undefined) next[k] = !!patch[k];
  }
  if (patch?.posReminderMin !== undefined) {
    next.posReminderMin = Math.max(1, Math.min(30, Math.floor(Number(patch.posReminderMin) || DEFAULTS.posReminderMin)));
  }
  if (patch?.payMethods) {
    for (const m of ["mpesa", "pesapal", "card", "cash"] as const) {
      if (patch.payMethods[m] !== undefined) next.payMethods[m] = !!patch.payMethods[m];
    }
  }
  if (next.payAtTable && !Object.values(next.payMethods).some(Boolean)) {
    throw new Error("Turn on at least one way to pay, or switch off pay at the table");
  }
  return next;
}

function pick(raw: any): Partial<VenueSettings> {
  const out: Partial<VenueSettings> = {};
  if (["guest", "staff", "off"].includes(raw.ordering)) out.ordering = raw.ordering;
  for (const k of ["waiterCalls", "payAtTable", "posHandoff", "confirmBill"] as const) {
    if (typeof raw[k] === "boolean") out[k] = raw[k];
  }
  if (Number.isFinite(raw.posReminderMin)) out.posReminderMin = raw.posReminderMin;
  return out;
}
