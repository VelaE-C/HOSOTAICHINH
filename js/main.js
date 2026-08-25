// ============================================================
// main.js — Điểm khởi động: kiểm tra đăng nhập trước khi hiện bất kỳ màn hình nào
// ============================================================
import { supabase } from './core/config.js';
import { signInWithMicrosoft, signOut, getCurrentAppUser, onAuthStateChange } from './core/auth.js';
import { renderShell } from './core/shell.js';
import { initModalBackHandler } from './core/utils.js';

initModalBackHandler(); // 1 lần duy nhất — để nút Back/vuốt lùi trên điện thoại đóng đúng form đang mở thay vì kẹt màn hình

let currentUser = null;

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
        <img class="brand-mark" src="https://raw.githubusercontent.com/VelaE-C/HOSOTAICHINH/refs/heads/main/LOGO%20DUNG.JPEG.png" alt="VELA">
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
  renderShell(user);
}

onAuthStateChange((event) => {
  // CHỈ load lại toàn bộ app khi thật sự đăng nhập/đăng xuất — Supabase còn bắn ra
  // nhiều sự kiện "vô hại" khác (làm mới phiên ngầm, cập nhật thông tin...) không
  // nên render lại từ đầu, đây chính là nguyên nhân gây giật/tự load lại liên tục.
  if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') boot();
});

boot();
