// ============================================================
// main.js — Điểm khởi động: kiểm tra đăng nhập trước khi hiện bất kỳ màn hình nào
// ============================================================
import { supabase } from './core/config.js';
import { signInWithMicrosoft, signOut, getCurrentAppUser, onAuthStateChange } from './core/auth.js';

let currentUser = null;
let booted = false; // tránh render trùng khi Supabase bắn nhiều sự kiện auth liên tiếp lúc khởi động

async function boot() {
  const { data } = await supabase.auth.getSession();

  if (!data.session) {
    renderLoginScreen();
    return;
  }

  currentUser = await getCurrentAppUser();

  if (!currentUser) {
    renderLoginScreen();
    return;
  }
  if (currentUser.notRegistered) {
    renderNotRegisteredScreen(currentUser.email);
    return;
  }
  if (currentUser.deactivated) {
    renderDeactivatedScreen(currentUser.email);
    return;
  }

  renderApp(currentUser);
}

function renderLoginScreen() {
  document.getElementById('app-root').innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <div class="brand-mark">V</div>
        <h1>VELA Hồ sơ Tài chính</h1>
        <p>Đăng nhập bằng tài khoản Outlook công ty — không dùng mật khẩu riêng.</p>
        <button id="btnMsLogin" class="btn btn-primary" style="width:100%">Đăng nhập bằng Microsoft</button>
      </div>
    </div>`;
  document.getElementById('btnMsLogin').addEventListener('click', signInWithMicrosoft);
}

function renderNotRegisteredScreen(email) {
  document.getElementById('app-root').innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <h1>Chưa có quyền truy cập</h1>
        <p>Email <b>${email}</b> đăng nhập thành công, nhưng chưa được khai báo trong hệ thống.</p>
        <p style="color:var(--gray5);font-size:13px">Liên hệ phòng IT hoặc QLCP&HĐ để được cấp quyền truy cập.</p>
        <button id="btnLogout" class="btn btn-secondary" style="width:100%">Đăng xuất, thử tài khoản khác</button>
      </div>
    </div>`;
  document.getElementById('btnLogout').addEventListener('click', signOut);
}

function renderDeactivatedScreen(email) {
  document.getElementById('app-root').innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <h1>Tài khoản đã bị khóa</h1>
        <p>Email <b>${email}</b> đã bị vô hiệu hóa trong hệ thống.</p>
        <button id="btnLogout" class="btn btn-secondary" style="width:100%">Đăng xuất</button>
      </div>
    </div>`;
  document.getElementById('btnLogout').addEventListener('click', signOut);
}

function renderApp(user) {
  // Mốc bàn giao cho bước tiếp theo: dựng sidebar/topbar thật + nối các module
  // (dashboard.js, hopdong.js, bill.js...) — hiện tại chỉ hiện xác nhận đăng nhập thành công
  document.getElementById('app-root').innerHTML = `
    <div style="padding:40px;font-family:sans-serif">
      <h2>✅ Đăng nhập thành công</h2>
      <p>Xin chào <b>${user.full_name}</b> (${user.email})</p>
      <p>Vai trò: ${user.roles.length ? user.roles.join(', ') : '⚠️ Chưa được gán vai trò nào — báo QLCP&HĐ'}</p>
      <p style="color:var(--gray5);font-size:13px">Bước tiếp theo: dựng giao diện chính (sidebar, dashboard...) tại đây.</p>
    </div>`;
}

onAuthStateChange(() => {
  if (booted) boot();
});

booted = true;
boot();
