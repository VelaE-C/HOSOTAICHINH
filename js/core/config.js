// ============================================================
// config.js — Kết nối Supabase. KHÔNG sửa file này ở các app khác,
// mỗi app có project Supabase riêng.
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Lấy ở Supabase → Settings → API
export const SUPABASE_URL = 'https://gvhwjemqarnevatwuktq.supabase.co';
export const SUPABASE_ANON_KEY = 'DÁN_PUBLISHABLE_KEY_VÀO_ĐÂY'; // sb_publishable_... — KHÔNG dùng secret key ở đây

export const APP_NAME = 'VELA Hồ Sơ TC';
export const APP_BASE_URL = 'https://velae-c.github.io/VELA_HSTC';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
