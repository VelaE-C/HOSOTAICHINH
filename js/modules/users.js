// ============================================================
// users.js — Quản lý người dùng, vai trò, phân công theo dự án.
// Chỉ Admin (IT) và Trưởng phòng QLCP&HĐ thấy tab này.
// ============================================================
import { supabase } from '../core/config.js';
import { toast, loading, fmtDate } from '../core/utils.js';

const ALL_ROLES = ['QS', 'CHT', 'GDDA', 'ChuyenVienPhongBan', 'TruongPhongChucNang', 'PhapChe_CV', 'PhapChe_TP', 'KeToan_Vien', 'KeToan_Truong', 'QLCPHD_CV', 'QLCPHD_TP', 'PTGD', 'TGD', 'Admin'];
const PROJECT_ROLES = ['QS', 'CHT', 'GDDA', 'PTGD'];

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải…</div>`;

  const { data: users, error } = await supabase.from('users').select('id, email, full_name, is_active').order('full_name');
  if (error) {
    container.innerHTML = `<div class="empty-note">⚠️ Không có quyền xem, hoặc lỗi: ${error.message}</div>`;
    return;
  }
  const { data: roles } = await supabase.from('user_roles').select('user_id, role_type');
  const roleMap = {};
  (roles || []).forEach((r) => (roleMap[r.user_id] = [...(roleMap[r.user_id] || []), r.role_type]));

  container.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:12px">
      <button class="btn btn-primary" id="btnNew">+ Thêm người dùng</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden"><table><thead><tr><th>Họ tên</th><th>Email</th><th>Vai trò</th><th>Trạng thái</th></tr></thead><tbody>
    ${users && users.length ? users.map((u) => `<tr class="click" data-id="${u.id}"><td>${u.full_name}</td><td class="mono">${u.email}</td>
    <td>${(roleMap[u.id] || []).map((r) => `<span class="code-chip" style="margin:1px 3px 1px 0">${r}</span>`).join('') || '<span style="color:var(--amber);font-size:12px">Chưa gán</span>'}</td>
    <td>${u.is_active ? '<span class="badge done">Đang hoạt động</span>' : '<span class="badge danger">Đã khóa</span>'}</td></tr>`).join('') :
    `<tr><td colspan="4" style="text-align:center;color:var(--gray4);padding:20px">Chưa có người dùng nào</td></tr>`}
    </tbody></table></div>`;

  container.querySelector('#btnNew').addEventListener('click', () => openCreateUserModal(user, () => render(container, user)));
  container.querySelectorAll('[data-id]').forEach((r) => r.addEventListener('click', () => openUserDetail(r.dataset.id, user, () => render(container, user))));
}

async function openUserDetail(id, currentUser, onClose) {
  const modal = ensureModal();
  modal.innerHTML = `<div class="panel-box"><div class="empty-note">Đang tải…</div></div>`;
  showModal(modal, onClose);

  const { data: u } = await supabase.from('users').select('*').eq('id', id).single();
  const { data: myRoles } = await supabase.from('user_roles').select('id, role_type, department').eq('user_id', id);
  const { data: myAssignments } = await supabase
    .from('project_role_assignments')
    .select('id, role_type, effective_from, effective_to, projects(code, name)')
    .eq('user_id', id)
    .is('effective_to', null)
    .order('role_type');
  const { data: projects } = await supabase.from('projects').select('id, code, name').order('code');

  const box = modal.querySelector('.panel-box');
  box.innerHTML = `
    <div class="panel-header"><div><div>${u.full_name}</div><div class="meta">${u.email}</div></div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="margin-bottom:16px">
        <label class="form-label">Trạng thái tài khoản</label>
        <button class="btn btn-sm ${u.is_active ? 'btn-danger' : 'btn-secondary'}" id="btnToggleActive">${u.is_active ? '🔒 Khóa tài khoản' : '✓ Kích hoạt lại'}</button>
      </div>

      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Vai trò hệ thống</div>
      <div class="card">
        <div id="roleList" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">
          ${(myRoles || []).map((r) => `<span class="code-chip">${r.role_type} <span data-rm-role="${r.id}" style="cursor:pointer;color:var(--red);font-weight:700;margin-left:3px">✕</span></span>`).join('') || '<span style="color:var(--gray4);font-size:12px">Chưa có vai trò nào</span>'}
        </div>
        <div style="display:flex;gap:8px">
          <select id="fAddRole" class="form-input">${ALL_ROLES.map((r) => `<option value="${r}">${r}</option>`).join('')}</select>
          <button class="btn btn-sm btn-secondary" id="btnAddRole">+ Thêm</button>
        </div>
      </div>

      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Phân công theo dự án (QS / CHT / GĐDA / PTGD)</div>
      <div class="card">
        <div id="assignList" style="margin-bottom:10px">
          ${(myAssignments || []).length ? myAssignments.map((a) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--gray1);font-size:13px">
            <span><span class="code-chip">${a.role_type}</span> ${a.projects?.code} — ${a.projects?.name} <span style="color:var(--gray4)">(từ ${fmtDate(a.effective_from)})</span></span>
            <span data-end-assign="${a.id}" style="cursor:pointer;color:var(--red);font-size:12px">Kết thúc</span>
          </div>`).join('') : '<div style="color:var(--gray4);font-size:12px">Chưa phân công dự án nào</div>'}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px">
          <select id="fAssignProject" class="form-input">${(projects || []).map((p) => `<option value="${p.id}">${p.code}</option>`).join('')}</select>
          <select id="fAssignRole" class="form-input">${PROJECT_ROLES.map((r) => `<option value="${r}">${r}</option>`).join('')}</select>
          <button class="btn btn-sm btn-secondary" id="btnAddAssign">+ Phân công</button>
        </div>
      </div>
    </div>`;

  box.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  box.querySelector('#btnToggleActive').addEventListener('click', async () => {
    loading(true);
    const { error } = await supabase.from('users').update({ is_active: !u.is_active }).eq('id', id);
    if (error) return toast('Lỗi: ' + error.message, 'error');
    toast(u.is_active ? 'Đã khóa tài khoản' : 'Đã kích hoạt lại', 'success');
    openUserDetail(id, currentUser, onClose);
  });

  box.querySelector('#btnAddRole').addEventListener('click', async () => {
    const role_type = box.querySelector('#fAddRole').value;
    const { error } = await supabase.from('user_roles').insert({ user_id: id, role_type });
    if (error) return toast('Lỗi (có thể vai trò này đã có): ' + error.message, 'error');
    toast('Đã thêm vai trò', 'success');
    openUserDetail(id, currentUser, onClose);
  });

  box.querySelectorAll('[data-rm-role]').forEach((el) =>
    el.addEventListener('click', async () => {
      await supabase.from('user_roles').delete().eq('id', el.dataset.rmRole);
      toast('Đã xóa vai trò', 'success');
      openUserDetail(id, currentUser, onClose);
    }),
  );

  box.querySelector('#btnAddAssign').addEventListener('click', async () => {
    const project_id = box.querySelector('#fAssignProject').value;
    const role_type = box.querySelector('#fAssignRole').value;
    const { error } = await supabase.from('project_role_assignments').insert({ project_id, user_id: id, role_type, effective_from: new Date().toISOString().slice(0, 10), created_by: currentUser.id });
    if (error) return toast('Lỗi: ' + error.message, 'error');
    toast('Đã phân công dự án', 'success');
    openUserDetail(id, currentUser, onClose);
  });

  box.querySelectorAll('[data-end-assign]').forEach((el) =>
    el.addEventListener('click', async () => {
      if (!confirm('Kết thúc phân công này? Hồ sơ cũ vẫn định tuyến đúng người phụ trách tại thời điểm đã trình.')) return;
      await supabase.from('project_role_assignments').update({ effective_to: new Date().toISOString().slice(0, 10) }).eq('id', el.dataset.endAssign);
      toast('Đã kết thúc phân công', 'success');
      openUserDetail(id, currentUser, onClose);
    }),
  );
}

async function openCreateUserModal(currentUser, onClose) {
  const modal = ensureModal();
  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Thêm người dùng mới</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="font-size:12px;background:var(--lblue);color:#1D4ED8;padding:9px 12px;border-radius:7px;margin-bottom:14px">ℹ️ Nhập đúng email Outlook công ty — người này đăng nhập bằng chính email đó, không có mật khẩu riêng.</div>
      <div style="margin-bottom:13px"><label class="form-label">Email Outlook công ty *</label><input type="email" id="fEmail" class="form-input" placeholder="ten.nhanvien@velaec.vn"></div>
      <div style="margin-bottom:13px"><label class="form-label">Họ tên *</label><input type="text" id="fName" class="form-input"></div>
      <div style="margin-bottom:13px"><label class="form-label">Điện thoại</label><input type="text" id="fPhone" class="form-input"></div>
    </div>
    <div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">Lưu — gán vai trò ở bước sau</button></div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const email = modal.querySelector('#fEmail').value.trim();
    const full_name = modal.querySelector('#fName').value.trim();
    const phone = modal.querySelector('#fPhone').value.trim() || null;
    if (!email || !full_name) return toast('Điền đủ email và họ tên', 'error');

    loading(true);
    const { error } = await supabase.from('users').insert({ email, full_name, phone });
    if (error) return toast('Lỗi (có thể email đã tồn tại): ' + error.message, 'error');
    toast('Đã thêm người dùng — bấm vào tên họ để gán vai trò', 'success');
    closeModal(modal, onClose);
  });
}

function ensureModal() {
  let modal = document.getElementById('module-overlay');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'module-overlay';
    modal.className = 'overlay';
    modal.innerHTML = `<div class="panel-box"></div>`;
    document.body.appendChild(modal);
  }
  return modal;
}
function showModal(modal, onClose) {
  modal.classList.add('show');
  modal.onclick = (e) => { if (e.target === modal) closeModal(modal, onClose); };
}
function closeModal(modal, onClose) {
  modal.classList.remove('show');
  if (onClose) onClose();
}
