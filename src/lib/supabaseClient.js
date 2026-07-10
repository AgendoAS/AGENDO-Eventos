import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn('Supabase não configurado. Verifique o arquivo .env');
}

export const supabase = createClient(supabaseUrl, supabaseKey);
export const EVENTO_ID = import.meta.env.VITE_EVENTO_ID;

// Cliente somente-leitura do banco do CAPETTE (chave publishable, já pública no CAPETTE).
// Usado só pra listar os eventos do CAPETTE no seletor de exportação.
export const capette = createClient(
  'https://aarjhtvjbydmqipczagy.supabase.co',
  'sb_publishable_KDDURuVKYYAmCklf51LkNg_ucMaIUma'
);