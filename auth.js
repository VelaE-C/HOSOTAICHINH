// ============================================================
// auth.js — Đăng nhập bằng Microsoft (Outlook), không dùng mật khẩu riêng của app
// ============================================================
import { supabase } from './config.js';

export async function signInWithMicrosoft() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'azure',
    options: {
      scopes: 'email',
      redirectTo: window.location.origin + window.location.pathname,
    },
  });
  if (error) {
    console.error('Đăng nhập thất bại:', error);
    alert('Không đăng nhập được — thử lại sau, hoặc báo IT nếu lặp lại nhiều lần.');
  }
}

export async function signOut() {
  await supabase.auth.signOut();
  window.location.reload();
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

// Đối chiếu email vừa đăng nhập với bảng public.users để lấy vai trò trong app
// (đăng nhập Microsoft thành công KHÔNG có nghĩa là có quyền dùng app —
// email đó phải được IT khai báo sẵn trong bảng users trước)
export async function getCurrentAppUser() {
  const session = await getSession();
  if (!session) return null;
  const email = session.user.email;

  const { data: user, error } = await supabase
    .from('users')
    .select('id, email, full_name, phone, is_active')
    .eq('email', email)
    .single();

  if (error || !user) {
    return { notRegistered: true, email };
  }
  if (!user.is_active) {
    return { deactivated: true, email };
  }

  const { data: roles } = await supabase
    .from('user_roles')
    .select('role_type, department')
    .eq('user_id', user.id);

  return { ...user, roles: (roles || []).map((r) => r.role_type) };
}

export function onAuthStateChange(callback) {
  supabase.auth.onAuthStateChange((_event, session) => callback(session));
}
