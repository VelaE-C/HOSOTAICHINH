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
  QS: ['hopdong', 'bill', 'totrinh', 'nganSach', 'hopdongdaura', 'doitac'],
  CHT: ['dashboard', 'duyet', 'hopdong', 'bill', 'totrinh', 'nganSach', 'hopdongdaura', 'doitac'],
  GDDA: ['dashboard', 'duyet', 'hopdong', 'bill', 'totrinh', 'nganSach', 'hopdongdaura', 'doitac'],
  ChuyenVienPhongBan: ['hopdong', 'bill', 'totrinh', 'nganSach', 'hopdongdaura', 'doitac'],
  TruongPhongChucNang: ['dashboard', 'duyet', 'hopdong', 'bill', 'totrinh', 'nganSach', 'hopdongdaura', 'doitac'],
  PhapChe_CV: ['duyet', 'hopdong', 'totrinh', 'nganSach', 'hopdongdaura', 'doitac'],
  PhapChe_TP: ['dashboard', 'duyet', 'hopdong', 'totrinh', 'nganSach', 'hopdongdaura', 'doitac'],
  KeToan_Vien: ['duyet', 'hopdong', 'bill', 'totrinh', 'nganSach', 'hopdongdaura', 'doitac'],
  KeToan_Truong: ['dashboard', 'duyet', 'hopdong', 'bill', 'totrinh', 'nganSach', 'hopdongdaura', 'doitac'],
  QLCPHD_CV: ['duyet', 'hopdong', 'bill', 'totrinh', 'nganSach', 'hopdongdaura', 'doitac'],
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

// Đếm số hồ sơ đang chờ đúng người này duyệt — cập nhật huy hiệu đỏ cạnh "Duyệt hồ sơ"
async function refreshPendingBadge() {
  if (!CURRENT_USER) return;
  const { count } = await supabase
    .from('approval_assignments')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', CURRENT_USER.id)
    .eq('status', 'pending');
  const n = count || 0;
  document.querySelectorAll('[data-badge="duyet"]').forEach((el) => {
    el.textContent = n > 99 ? '99+' : n;
    el.style.display = n > 0 ? 'inline-flex' : 'none';
  });
}

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
  refreshPendingBadge();

  document.getElementById('btnLogout').addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.reload();
  });
  document.getElementById('hamburger').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });

  // Đọc tab (+ id hồ sơ nếu có, VD #hopdong/eeef68b9...) từ URL — để F5 hoặc mở link
  // email không bị mất chỗ đang xem, kể cả đúng hồ sơ cụ thể đang mở.
  const [hashTab, hashSubId] = window.location.hash.replace('#', '').split('/');
  const initial = visibleNav.find((n) => n.id === hashTab) ? hashTab : visibleNav[0]?.id || 'dashboard';
  switchView(initial).then(() => openDeepLinkIfAny(initial, hashSubId));

  // Hỗ trợ nút Back/Forward của trình duyệt + đường dẫn dạng tab/id
  window.onhashchange = () => {
    const [tab, subId] = window.location.hash.replace('#', '').split('/');
    if (visibleNav.find((n) => n.id === tab) && tab !== CURRENT_VIEW) {
      switchView(tab).then(() => openDeepLinkIfAny(tab, subId));
    }
    // Nếu tab không đổi (chỉ mất /id do bấm Back đóng chi tiết) — đã có initModalBackHandler()
    // (trong utils.js) tự đóng modal đang mở, không cần xử lý thêm ở đây.
  };
}

// Nếu URL có kèm id hồ sơ (VD #hopdong/eeef68b9...), tự mở đúng chi tiết đó ngay sau khi vào tab
async function openDeepLinkIfAny(tab, subId) {
  if (!subId || !['hopdong', 'bill', 'totrinh'].includes(tab)) return;
  try {
    const mod = await loadModule(tab);
    if (mod.openDetail) await mod.openDetail(subId, CURRENT_USER, () => {});
  } catch (e) {
    console.error('Không mở được hồ sơ từ link:', e);
  }
}

function buildSidebar(visibleNav) {
  let html = '';
  let lastGroup = null;
  visibleNav.forEach((n) => {
    if (n.group !== lastGroup) {
      html += `<div class="sb-group">${n.group}</div>`;
      lastGroup = n.group;
    }
    html += `<button class="sb-item" data-nav="${n.id}"><span class="sb-icon">${n.icon}</span>${n.label}${n.id === 'duyet' ? `<span class="sb-badge" data-badge="duyet" style="display:none"></span>` : ''}</button>`;
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
    .map((n) => `<button class="bn-item" data-nav="${n.id}"><span class="bn-icon">${n.icon}${n.id === 'duyet' ? `<span class="sb-badge bn-badge" data-badge="duyet" style="display:none"></span>` : ''}</span>${n.label}</button>`)
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
  // Chỉ so sánh đúng phần tab — nếu đang có sẵn /id (VD từ link email) và tab không đổi,
  // giữ nguyên để phần mở chi tiết bên dưới hoạt động, không xóa mất trước khi kịp mở
  const currentHashTab = window.location.hash.replace('#', '').split('/')[0];
  if (currentHashTab !== id) window.location.hash = id;

  document.querySelectorAll('.sb-item').forEach((b) => b.classList.toggle('active', b.dataset.nav === id));
  document.querySelectorAll('.bn-item[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === id));
  const n = NAV.find((x) => x.id === id);
  document.getElementById('pgTitle').textContent = n?.title || '';
  document.getElementById('pgSub').textContent = n?.sub || '';

  const container = document.getElementById('view-content');
  container.innerHTML = `<div class="empty-note">Đang tải…</div>`;
  refreshPendingBadge(); // cập nhật lại mỗi lần chuyển tab — bắt kịp ngay sau khi vừa duyệt/từ chối xong 1 hồ sơ
  try {
    const mod = await loadModule(id);
    await mod.render(container, CURRENT_USER);
  } catch (e) {
    console.error(e);
    container.innerHTML = `<div class="empty-note">⚠️ Module "${id}" chưa được xây dựng, hoặc có lỗi khi tải.</div>`;
  }
}
