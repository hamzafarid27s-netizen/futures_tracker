import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Background alerts are entirely optional — if these env vars aren't set
// (e.g. someone deploying without going through the Supabase setup), the
// app still works fine in foreground-only mode. Every caller of `supabase`
// checks `isBackgroundAlertsConfigured()` first.
export const isBackgroundAlertsConfigured = () => Boolean(url && anonKey);

export const supabase = isBackgroundAlertsConfigured() ? createClient(url, anonKey) : null;
