import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn('Supabase não configurado. Verifique o arquivo .env');
}

export const supabase = createClient(supabaseUrl, supabaseKey);
export const EVENTO_ID = import.meta.env.VITE_EVENTO_ID;