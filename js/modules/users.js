// ============================================================
// users.js — Quản lý người dùng, vai trò, phân công theo dự án.
// Chỉ Admin (IT) và Trưởng phòng QLCP&HĐ thấy tab này.
// ============================================================
import { supabase } from '../core/config.js';
import { toast, loading, fmtDate } from '../core/utils.js';

const ALL_ROLES = ['QS', 'CHT', 'GDDA', 'ChuyenVienPhongBan', 'TruongPhongChucNang', 'PhapChe_CV', 'PhapChe_TP', 'KeToan_Vien', 'KeToan_Truong', 'QLCPHD_CV', 'QLCPHD_TP', 'PTGD', 'TGD', 'Admin'];
const PROJECT_ROLES = ['QS', 'CHT', 'GDDA', 'PTGD'];
const DOC_TYPE_LABEL = { contract: 'Hợp đồng', bill: 'Bill thanh toán', totrinh: 'Tờ trình chủ trương' };

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải…</div>`;

  const { data: templates } = await supabase.from('document_templates').select('id, name, doc_type, origin_scope, is_active');
  const { data: allSteps } = await supabase.from('template_steps').select('template_id, step_no');
  const stepCountMap = {};
  (allSteps || []).forEach((s) => (stepCountMap[s.template_id] = (stepCountMap[s.template_id] || 0) + 1));

  const { data: projects, error: projErr } = await supabase.from('projects').select('id, code, name, investor, location, project_type, unit_count, status').order('code');
  const { data: users, error } = await supabase.from('users').select('id, email, full_name, is_active').order('full_name');
  if (error) {
    container.innerHTML = `<div class="empty-note">⚠️ Không có quyền xem, hoặc lỗi: ${error.message}</div>`;
    return;
  }
  const { data: roles } = await supabase.from('user_roles').select('user_id, role_type');
  const roleMap = {};
  (roles || []).forEach((r) => (roleMap[r.user_id] = [...(roleMap[r.user_id] || []), r.role_type]));

  const statusVN = { active: 'Đang thi công', completed: 'Hoàn thành', paused: 'Tạm dừng' };

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;margin-bottom:8px;align-items:center">
      <div class="card-title" style="margin:0">Dự án</div>
      <button class="btn btn-primary btn-sm" id="btnNewProject">+ Tạo dự án mới</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden;margin-bottom:22px">
      ${projErr ? `<div class="empty-note">⚠️ Không có quyền xem, hoặc lỗi: ${projErr.message}</div>` : `
      <table><thead><tr><th>Mã</th><th>Tên dự án</th><th>Chủ đầu tư</th><th>Địa điểm</th><th>Loại hình</th><th>Số căn</th><th>Trạng thái</th></tr></thead><tbody>
      ${projects && projects.length ? projects.map((p) => `<tr><td class="mono">${p.code}</td><td>${p.name}</td><td>${p.investor || '—'}</td><td>${p.location || '—'}</td><td>${p.project_type || '—'}</td><td>${p.unit_count || '—'}</td><td><span class="badge idle">${statusVN[p.status] || p.status}</span></td></tr>`).join('') :
      `<tr><td colspan="7" style="text-align:center;color:var(--gray4);padding:20px">Chưa có dự án nào</td></tr>`}
      </tbody></table>`}
    </div>

    <div style="display:flex;justify-content:space-between;margin-bottom:8px;align-items:center">
      <div class="card-title" style="margin:0">Mẫu hồ sơ (luồng duyệt)</div>
      <button class="btn btn-primary btn-sm" id="btnNewTemplate">+ Tạo mẫu mới</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden;margin-bottom:22px">
      <table><thead><tr><th>Tên mẫu</th><th>Áp dụng cho loại hồ sơ</th><th>Đơn vị trình</th><th>Số bước</th></tr></thead><tbody>
      ${templates && templates.length ? templates.map((t) => `<tr><td>${t.name}</td><td><span class="badge info">${DOC_TYPE_LABEL[t.doc_type] || t.doc_type}</span></td><td>${t.origin_scope === 'site' ? 'Công trường' : 'Phòng ban'}</td><td>${stepCountMap[t.id] || 0} vai trò / ${new Set((allSteps || []).filter((s) => s.template_id === t.id).map((s) => s.step_no)).size} bước</td></tr>`).join('') :
      `<tr><td colspan="4" style="text-align:center;color:var(--gray4);padding:20px">Chưa có mẫu hồ sơ nào</td></tr>`}
      </tbody></table>
    </div>

    <div style="display:flex;justify-content:space-between;margin-bottom:8px;align-items:center">
      <div class="card-title" style="margin:0">Người dùng</div>
      <button class="btn btn-primary btn-sm" id="btnNew">+ Thêm người dùng</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden"><table><thead><tr><th>Họ tên</th><th>Email</th><th>Vai trò</th><th>Trạng thái</th></tr></thead><tbody>
    ${users && users.length ? users.map((u) => `<tr class="click" data-id="${u.id}"><td>${u.full_name}</td><td class="mono">${u.email}</td>
    <td>${(roleMap[u.id] || []).map((r) => `<span class="code-chip" style="margin:1px 3px 1px 0">${r}</span>`).join('') || '<span style="color:var(--amber);font-size:12px">Chưa gán</span>'}</td>
    <td>${u.is_active ? '<span class="badge done">Đang hoạt động</span>' : '<span class="badge danger">Đã khóa</span>'}</td></tr>`).join('') :
    `<tr><td colspan="4" style="text-align:center;color:var(--gray4);padding:20px">Chưa có người dùng nào</td></tr>`}
    </tbody></table></div>`;

  container.querySelector('#btnNewProject').addEventListener('click', () => openCreateProjectModal(() => render(container, user)));
  container.querySelector('#btnNewTemplate').addEventListener('click', () => openCreateTemplateModal(() => render(container, user)));
  container.querySelector('#btnNew').addEventListener('click', () => openCreateUserModal(user, () => render(container, user)));
  container.querySelectorAll('[data-id]').forEach((r) => r.addEventListener('click', () => openUserDetail(r.dataset.id, user, () => render(container, user))));
}

async function openCreateTemplateModal(onClose) {
  const modal = ensureModal();
  const { data: existingTemplates } = await supabase.from('document_templates').select('id, name');
  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Tạo mẫu hồ sơ mới</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="font-size:12px;background:var(--lblue);color:#1D4ED8;padding:9px 12px;border-radius:7px;margin-bottom:14px">ℹ️ Mỗi bước phải chọn ít nhất 1 vai trò — bỏ trống 1 bước sẽ khiến hồ sơ bị kẹt mãi ở bước đó, không ai duyệt được.</div>
      ${existingTemplates && existingTemplates.length ? `<div style="margin-bottom:16px"><label class="form-label">Nhân bản từ mẫu có sẵn (không bắt buộc — đỡ phải tick lại từ đầu)</label>
        <select id="fCopyFrom" class="form-input"><option value="">— Tạo từ đầu —</option>${existingTemplates.map((t) => `<option value="${t.id}">${t.name}</option>`).join('')}</select></div>` : ''}
      <div style="margin-bottom:13px"><label class="form-label">Tên mẫu *</label><input type="text" id="fName" class="form-input" placeholder="VD: Hợp đồng văn phòng - Phòng Thiết bị"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:13px">
        <div><label class="form-label">Áp dụng cho loại hồ sơ *</label>
          <select id="fDocType" class="form-input"><option value="contract">Hợp đồng</option><option value="bill">Bill thanh toán</option><option value="totrinh">Tờ trình chủ trương</option></select></div>
        <div><label class="form-label">Đơn vị trình *</label>
          <select id="fScope" class="form-input"><option value="site">Công trường</option><option value="department">Phòng ban</option></select>
          <div style="font-size:11px;color:var(--gray4);margin-top:4px">Công trường: PTGD phân theo dự án. Phòng ban: PTGD phân theo phòng ban (ô bên dưới).</div></div>
      </div>
      <div style="margin-bottom:13px"><label class="form-label">Mô tả</label><input type="text" id="fDesc" class="form-input"></div>
      ${[1, 2, 3, 4].map((step) => `
        <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Bước ${step}</div>
        <div class="card" style="padding:10px 14px;display:grid;grid-template-columns:1fr 1fr;gap:6px 10px">
          ${ALL_ROLES.map((r) => {
            const needsDept = r === 'TruongPhongChucNang' || r === 'ChuyenVienPhongBan' || r === 'PTGD';
            return `<label style="font-size:12.5px;display:flex;align-items:center;gap:6px;cursor:pointer">
              <input type="checkbox" class="step-role" data-step="${step}" data-role="${r}">${r}
              ${needsDept ? `<input type="text" class="step-dept form-input dept-for-${r === 'PTGD' ? 'ptgd' : 'office'}" data-step="${step}" data-role="${r}" placeholder="Phòng ban (vd: Thiết bị)" style="width:130px;padding:3px 7px;font-size:11px">` : ''}
            </label>`;
          }).join('')}
        </div>`).join('')}
    </div>
    <div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">Lưu mẫu hồ sơ</button></div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  // PTGD chỉ cần ô phòng ban khi Đơn vị trình = Phòng ban; ở Công trường PTGD phân theo
  // dự án nên ẩn ô này đi, tránh nhầm lẫn
  function togglePtgdDept() {
    const isDept = modal.querySelector('#fScope').value === 'department';
    modal.querySelectorAll('.dept-for-ptgd').forEach((el) => {
      el.style.display = isDept ? '' : 'none';
      if (!isDept) el.value = '';
    });
  }
  modal.querySelector('#fScope').addEventListener('change', togglePtgdDept);
  togglePtgdDept();

  // Nhân bản: tick sẵn đúng các ô của mẫu được chọn, kể cả phòng ban đã ghi
  modal.querySelector('#fCopyFrom')?.addEventListener('change', async (e) => {
    modal.querySelectorAll('.step-role').forEach((cb) => (cb.checked = false));
    modal.querySelectorAll('.step-dept').forEach((inp) => (inp.value = ''));
    if (!e.target.value) return;
    const { data: steps } = await supabase.from('template_steps').select('step_no, role_type, department').eq('template_id', e.target.value);
    (steps || []).forEach((s) => {
      const cb = modal.querySelector(`.step-role[data-step="${s.step_no}"][data-role="${s.role_type}"]`);
      if (cb) cb.checked = true;
      const dept = modal.querySelector(`.step-dept[data-step="${s.step_no}"][data-role="${s.role_type}"]`);
      if (dept && s.department) dept.value = s.department;
    });
    toast('Đã sao chép cấu hình — chỉnh sửa rồi lưu như mẫu mới', 'info');
  });

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const name = modal.querySelector('#fName').value.trim();
    const doc_type = modal.querySelector('#fDocType').value;
    const origin_scope = modal.querySelector('#fScope').value;
    const description = modal.querySelector('#fDesc').value.trim();
    if (!name) return toast('Điền tên mẫu', 'error');

    const checked = [...modal.querySelectorAll('.step-role:checked')].map((el) => {
      const deptInput = modal.querySelector(`.step-dept[data-step="${el.dataset.step}"][data-role="${el.dataset.role}"]`);
      return { step_no: Number(el.dataset.step), role_type: el.dataset.role, department: deptInput?.value.trim() || null };
    });
    const usedSteps = new Set(checked.map((c) => c.step_no));
    if (usedSteps.size < 1) return toast('Phải chọn ít nhất 1 vai trò ở ít nhất 1 bước', 'error');
    for (let s = 1; s <= Math.max(...usedSteps); s++) {
      if (!usedSteps.has(s)) return toast(`Bước ${s} đang trống nhưng bước ${s + 1} trở đi có chọn vai trò — phải điền đủ liên tiếp từ bước 1, không được bỏ trống ở giữa`, 'error');
    }

    loading(true);
    const { data: tpl, error } = await supabase.from('document_templates').insert({ name, doc_type, origin_scope, description }).select('id').single();
    if (error) return toast('Lỗi tạo mẫu: ' + error.message, 'error');

    const { error: stepErr } = await supabase.from('template_steps').insert(checked.map((c) => ({ template_id: tpl.id, step_no: c.step_no, role_type: c.role_type, department: c.department })));
    if (stepErr) return toast('Đã tạo mẫu nhưng lỗi lưu các bước: ' + stepErr.message, 'error');

    toast('Đã tạo mẫu hồ sơ mới', 'success');
    closeModal(modal, onClose);
  });
}

async function openCreateProjectModal(onClose) {
  const modal = ensureModal();
  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Tạo dự án mới</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="margin-bottom:13px"><label class="form-label">Mã dự án * (dùng trong số hợp đồng, viết liền không dấu, vd VEGACITY)</label><input type="text" id="fCode" class="form-input" style="text-transform:uppercase"></div>
      <div style="margin-bottom:13px"><label class="form-label">Tên dự án *</label><input type="text" id="fName" class="form-input"></div>
      <div style="margin-bottom:13px"><label class="form-label">Chủ đầu tư (CĐT)</label><input type="text" id="fInvestor" class="form-input"></div>
      <div style="margin-bottom:13px"><label class="form-label">Địa điểm</label><input type="text" id="fLocation" class="form-input"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:13px">
        <div><label class="form-label">Loại hình</label><input type="text" id="fType" class="form-input" placeholder="VD: Villa, Liền kề"></div>
        <div><label class="form-label">Số lượng căn</label><input type="number" id="fUnits" class="form-input"></div>
      </div>
      <div style="margin-bottom:13px"><label class="form-label">Ngày khởi công</label><input type="date" id="fStart" class="form-input"></div>
    </div>
    <div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">Lưu dự án</button></div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const code = modal.querySelector('#fCode').value.trim().toUpperCase();
    const name = modal.querySelector('#fName').value.trim();
    if (!code || !name) return toast('Điền đủ Mã dự án và Tên dự án', 'error');

    loading(true);
    const { error } = await supabase.from('projects').insert({
      code, name,
      investor: modal.querySelector('#fInvestor').value.trim() || null,
      location: modal.querySelector('#fLocation').value.trim() || null,
      project_type: modal.querySelector('#fType').value.trim() || null,
      unit_count: modal.querySelector('#fUnits').value ? Number(modal.querySelector('#fUnits').value) : null,
      start_date: modal.querySelector('#fStart').value || null,
      status: 'active',
    });
    if (error) return toast('Lỗi lưu dự án (mã có thể đã tồn tại): ' + error.message, 'error');
    toast('Đã tạo dự án mới', 'success');
    closeModal(modal, onClose);
  });
}

async function openUserDetail(id, currentUser, onClose) {
  const modal = ensureModal();
  modal.innerHTML = `<div class="panel-box"><div class="empty-note">Đang tải…</div></div>`;
  showModal(modal, onClose);

  const { data: u } = await supabase.from('users').select('*').eq('id', id).single();
  const { data: myRoles } = await supabase.from('user_roles').select('id, role_type, department').eq('user_id', id);
  const { data: myAssignments } = await supabase
    .from('project_role_assignments')
    .select('id, role_type, project_id, effective_from, effective_to, projects(code, name)')
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
          ${(myRoles || []).map((r) => `<span class="code-chip">${r.role_type}${r.department ? ' — ' + r.department : ''} <span data-rm-role="${r.id}" style="cursor:pointer;color:var(--red);font-weight:700;margin-left:3px">✕</span></span>`).join('') || '<span style="color:var(--gray4);font-size:12px">Chưa có vai trò nào</span>'}
        </div>
        <div style="display:flex;gap:8px">
          <select id="fAddRole" class="form-input">${ALL_ROLES.map((r) => `<option value="${r}">${r}</option>`).join('')}</select>
          <input type="text" id="fAddRoleDept" class="form-input" placeholder="Phòng ban (nếu là TP/CV phòng ban)" style="max-width:200px">
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
    const department = box.querySelector('#fAddRoleDept').value.trim() || null;
    const { error } = await supabase.from('user_roles').insert({ user_id: id, role_type, department });
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
    loading(true);
    const { data, error } = await supabase.rpc('fn_reassign_project_role', {
      p_project_id: project_id, p_role_type: role_type, p_new_user_id: id, p_actor_id: currentUser.id,
    });
    if (error) return toast('Lỗi: ' + error.message, 'error');
    if (data.old_user_id) {
      toast(`Đã thay người phụ trách — chuyển giao ${data.transferred_count} hồ sơ đang chờ duyệt sang người mới`, 'success');
    } else {
      toast('Đã phân công dự án', 'success');
    }
    openUserDetail(id, currentUser, onClose);
  });

  box.querySelectorAll('[data-end-assign]').forEach((el) =>
    el.addEventListener('click', async () => {
      const assignId = el.dataset.endAssign;
      const assignInfo = (myAssignments || []).find((a) => a.id === assignId);
      let pendingCount = 0;
      if (assignInfo) {
        const [{ data: cIds }, { data: bIds }, { data: tIds }] = await Promise.all([
          supabase.from('contracts').select('id').eq('project_id', assignInfo.project_id),
          supabase.from('bills').select('id').eq('project_id', assignInfo.project_id),
          supabase.from('to_trinh_chu_truong').select('id').eq('project_id', assignInfo.project_id),
        ]);
        const idsByType = { contract: (cIds || []).map((r) => r.id), bill: (bIds || []).map((r) => r.id), totrinh: (tIds || []).map((r) => r.id) };
        const counts = await Promise.all(
          Object.entries(idsByType).map(([docType, ids]) =>
            ids.length
              ? supabase.from('approval_assignments').select('id', { count: 'exact', head: true }).eq('user_id', id).eq('status', 'pending').eq('role_type', assignInfo.role_type).eq('document_type', docType).in('document_id', ids)
              : Promise.resolve({ count: 0 }),
          ),
        );
        pendingCount = counts.reduce((s, r) => s + (r.count || 0), 0);
      }
      const warn = pendingCount > 0 ? `\n\n⚠️ Người này còn ${pendingCount} hồ sơ đang chờ duyệt ở dự án này — nếu kết thúc mà KHÔNG gán người thay ngay, các hồ sơ đó sẽ bị treo, không ai duyệt được. Nên dùng khung "Phân công theo dự án" bên dưới để gán người mới thay vì chỉ bấm Kết thúc.` : '';
      if (!confirm('Kết thúc phân công này?' + warn)) return;
      await supabase.from('project_role_assignments').update({ effective_to: new Date().toISOString().slice(0, 10) }).eq('id', assignId);
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
