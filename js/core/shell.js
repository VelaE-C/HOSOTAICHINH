// ============================================================
// shell.js — Khung chính của app: topbar, sidebar, bottom nav.
// Tab nào hiện ra phụ thuộc vào vai trò thật của người đăng nhập (không phải giả lập nữa).
// ============================================================
import { supabase } from './config.js';

const NAV = [
  { id: 'dashboard', label: 'Tổng quan', icon: '📊', group: 'TỔNG QUAN', bn: true, title: 'Tổng quan', sub: 'Tình hình tài chính dự án theo thời gian thực' },
  { id: 'duyet', label: 'Duyệt hồ sơ', icon: '✅', group: 'HỒ SƠ', bn: true, title: 'Hộp thư chờ duyệt', sub: 'Hồ sơ đang chờ bạn xử lý — gộp mọi dự án' },
  { id: 'hopdong', label: 'Hợp đồng', icon: '📄', group: 'HỒ SƠ', bn: true, title: 'Hợp đồng đầu vào', sub: 'Thầu phụ, nhà cung cấp' },
  { id: 'bill', label: 'Bill thanh toán', icon: '💵', group: 'HỒ SƠ', bn: true, title: 'Bill thanh toán theo kỳ', sub: 'Tạm ứng, thanh toán sản lượng, quyết toán' },
  { id: 'totrinh', label: 'Tờ trình chủ trương', icon: '🗂️', group: 'HỒ SƠ', more: true, title: 'Tờ trình phê duyệt chủ trương', sub: 'Căn cứ cho hợp đồng' },
  { id: 'nganSach', label: 'Ngân sách', icon: '🧮', group: 'QUẢN TRỊ', more: true, title: 'Kiểm soát ngân sách', sub: 'Phân bổ · Cam kết · Thực chi' },
  { id: 'hopdongdaura', label: 'Hợp đồng đầu ra (CĐT)', icon: '🏦', group: 'QUẢN TRỊ', more: true, title: 'Hợp đồng đầu ra — Doanh thu', sub: 'Chỉ QLCP&HĐ tự nhập' },
  { id: 'doitac', label: 'Đối tác', icon: '🏗️', group: 'QUẢN TRỊ', more: true, title: 'Đối tác NTP / NCC', sub: 'Hồ sơ và lịch sử giao dịch' },
  { id: 'users', label: 'Người dùng', icon: '👤', group: 'QUẢN TRỊ', more: true, title: 'Quản trị hệ thống', sub: 'Dự án, người dùng, mẫu hồ sơ (luồng duyệt)' },
];

// Đúng theo bảng phân quyền mục 9 concept — 1 người có thể giữ nhiều vai trò,
// nên gộp (union) toàn bộ tab được phép của mọi vai trò họ đang giữ
const TAB_BY_ROLE = {
  QS: ['dashboard', 'hopdong', 'bill', 'totrinh', 'doitac'],
  CHT: ['dashboard', 'duyet', 'hopdong', 'bill', 'totrinh', 'doitac'],
  GDDA: ['dashboard', 'duyet', 'hopdong', 'bill', 'totrinh', 'doitac'],
  ChuyenVienPhongBan: ['dashboard', 'hopdong', 'bill', 'totrinh', 'doitac'],
  TruongPhongChucNang: ['dashboard', 'duyet', 'hopdong', 'bill', 'totrinh', 'doitac'],
  PhapChe_CV: ['dashboard', 'duyet', 'hopdong', 'totrinh', 'doitac'],
  PhapChe_TP: ['dashboard', 'duyet', 'hopdong', 'totrinh', 'doitac'],
  KeToan_Vien: ['dashboard', 'duyet', 'hopdong', 'bill', 'totrinh', 'doitac'],
  KeToan_Truong: ['dashboard', 'duyet', 'hopdong', 'bill', 'totrinh', 'doitac'],
  QLCPHD_CV: ['dashboard', 'duyet', 'hopdong', 'bill', 'totrinh', 'nganSach', 'hopdongdaura', 'doitac'],
  QLCPHD_TP: ['dashboard', 'duyet', 'hopdong', 'bill', 'totrinh', 'nganSach', 'hopdongdaura', 'doitac', 'users'],
  PTGD: ['dashboard', 'duyet', 'hopdong', 'bill', 'totrinh', 'nganSach', 'hopdongdaura', 'doitac'],
  TGD: ['dashboard', 'duyet', 'hopdong', 'bill', 'totrinh', 'nganSach', 'hopdongdaura', 'doitac'],
  Admin: ['dashboard', 'duyet', 'hopdong', 'bill', 'totrinh', 'nganSach', 'hopdongdaura', 'doitac', 'users'],
};

export function accessibleTabs(roles) {
  const set = new Set();
  (roles || []).forEach((r) => (TAB_BY_ROLE[r] || []).forEach((t) => set.add(t)));
  if (set.size === 0) set.add('dashboard'); // chưa gán vai trò vẫn thấy Tổng quan (rỗng), không vỡ giao diện
  return NAV.filter((n) => set.has(n.id));
}

const moduleCache = {};
let CURRENT_USER = null;
let CURRENT_VIEW = null;

export function renderShell(user) {
  CURRENT_USER = user;
  const visibleNav = accessibleTabs(user.roles);

  document.getElementById('app-root').innerHTML = `
    <div class="topbar">
      <button class="hamburger" id="hamburger">☰</button>
      <img class="logo" src="https://raw.githubusercontent.com/VelaE-C/HOSOTAICHINH/refs/heads/main/LOGO%20DUNG.JPEG.png" alt="VELA">
      <div class="appname">VELA Hồ Sơ TC</div>
      <div class="spacer"></div>
      <div class="user-info">
        <b>${user.full_name}</b>
        <span class="role-tag">${user.roles.length ? user.roles.join(', ') : 'Chưa gán vai trò'}</span>
      </div>
      <button class="logout-btn" id="btnLogout">Đăng xuất</button>
    </div>
    <div class="shell">
      <aside class="sidebar" id="sidebar"></aside>
      <main>
        <div class="page-head"><div><h1 id="pgTitle"></h1><div class="sub" id="pgSub"></div></div></div>
        <div class="content" id="view-content"></div>
      </main>
    </div>
    <div class="bottomnav"><div class="bn-inner" id="bnInner"></div></div>
    <div class="more-sheet" id="moreSheet"></div>
    <div id="toast-wrap"></div>
  `;

  buildSidebar(visibleNav);
  buildBottomNav(visibleNav);

  document.getElementById('btnLogout').addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.reload();
  });
  document.getElementById('hamburger').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });

  // Đọc tab đang xem từ URL (#hopdong, #bill...) — để F5 không bị mất chỗ đang xem.
  // Nếu URL không có hash, hoặc hash không phải tab hợp lệ với vai trò hiện tại, mới về tab đầu tiên.
  const hashId = window.location.hash.replace('#', '');
  const initial = visibleNav.find((n) => n.id === hashId) ? hashId : visibleNav[0]?.id || 'dashboard';
  switchView(initial);

  // Hỗ trợ nút Back/Forward của trình duyệt
  window.onhashchange = () => {
    const id = window.location.hash.replace('#', '');
    if (visibleNav.find((n) => n.id === id) && id !== CURRENT_VIEW) switchView(id);
  };
}

function buildSidebar(visibleNav) {
  let html = '';
  let lastGroup = null;
  visibleNav.forEach((n) => {
    if (n.group !== lastGroup) {
      html += `<div class="sb-group">${n.group}</div>`;
      lastGroup = n.group;
    }
    html += `<button class="sb-item" data-nav="${n.id}"><span class="sb-icon">${n.icon}</span>${n.label}</button>`;
  });
  document.getElementById('sidebar').innerHTML = html;
  document.querySelectorAll('.sb-item').forEach((b) =>
    b.addEventListener('click', () => {
      switchView(b.dataset.nav);
      document.getElementById('sidebar').classList.remove('open');
    }),
  );
}

function buildBottomNav(visibleNav) {
  const bnItems = visibleNav.filter((n) => n.bn);
  const moreItems = visibleNav.filter((n) => n.more);
  let html = bnItems
    .map((n) => `<button class="bn-item" data-nav="${n.id}"><span class="bn-icon">${n.icon}</span>${n.label.split(' ')[0]}</button>`)
    .join('');
  if (moreItems.length) html += `<button class="bn-item" id="bnMore"><span class="bn-icon">⋯</span>Thêm</button>`;
  document.getElementById('bnInner').innerHTML = html;
  document.querySelectorAll('#bnInner .bn-item[data-nav]').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.nav)));
  document.getElementById('bnMore')?.addEventListener('click', () => document.getElementById('moreSheet').classList.add('show'));
  document.getElementById('moreSheet').innerHTML =
    `<div class="sheet-handle"></div>` +
    moreItems.map((n) => `<div class="item" data-nav="${n.id}"><span>${n.icon}</span>${n.label}</div>`).join('');
  document.querySelectorAll('#moreSheet .item').forEach((el) =>
    el.addEventListener('click', () => {
      switchView(el.dataset.nav);
      document.getElementById('moreSheet').classList.remove('show');
    }),
  );
}

async function loadModule(id) {
  if (moduleCache[id]) return moduleCache[id];
  const mod = await import(`../modules/${id}.js`);
  moduleCache[id] = mod;
  return mod;
}

export async function switchView(id) {
  CURRENT_VIEW = id;
  if (window.location.hash.replace('#', '') !== id) window.location.hash = id;

  document.querySelectorAll('.sb-item').forEach((b) => b.classList.toggle('active', b.dataset.nav === id));
  document.querySelectorAll('.bn-item[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === id));
  const n = NAV.find((x) => x.id === id);
  document.getElementById('pgTitle').textContent = n?.title || '';
  document.getElementById('pgSub').textContent = n?.sub || '';

  const container = document.getElementById('view-content');
  container.innerHTML = `<div class="empty-note">Đang tải…</div>`;
  try {
    const mod = await loadModule(id);
    await mod.render(container, CURRENT_USER);
  } catch (e) {
    console.error(e);
    container.innerHTML = `<div class="empty-note">⚠️ Module "${id}" chưa được xây dựng, hoặc có lỗi khi tải.</div>`;
  }
}
