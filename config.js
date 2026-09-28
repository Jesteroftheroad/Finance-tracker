// Paste your Supabase project values here (Supabase → Project Settings → API).
// The anon / publishable key is safe to put in a public site: Row Level Security
// in schema.sql makes sure only your signed-in account can read or write rows.
window.FT_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-OR-PUBLISHABLE-KEY",

  // Accounts pre-filled the very first time you add a month.
  // After that, the form copies whatever cards/accounts your latest month had.
  DEFAULT_CARDS: ["Amex", "Scotia", "RBC"],
  DEFAULT_BANKS: ["EQ", "Scotia"],
};
