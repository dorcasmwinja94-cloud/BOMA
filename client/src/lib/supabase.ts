import { createClient, SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.REACT_APP_SUPABASE_URL || "";
const supabaseKey = process.env.REACT_APP_SUPABASE_PUBLISHABLE_KEY || "";

/**
 * Browser-side Supabase client. Authentication and all business data currently
 * flow through the Express API, so this client is available for Supabase
 * storage/auth features without exposing a secret key in the bundle.
 */
export const supabase: SupabaseClient | null =
  supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseKey);
