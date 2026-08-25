// ============================================================
// users.js — Quản lý người dùng, vai trò, phân công theo dự án.
// Chỉ Admin (IT) và Trưởng phòng QLCP&HĐ thấy tab này.
// ============================================================
import { supabase } from '../core/config.js';
import { toast, loading, fmtDate, pushModalHistory, popModalHistory } from '../core/utils.js';

const ALL_ROLES = ['QS', 'CHT', 'GDDA', 'ChuyenVienPhongBan', 'TruongPhongChucNang', 'PhapChe_CV', 'PhapChe_TP', 'KeToan_Vien', 'KeToan_Truong', 'QLCPHD_CV', 'QLCPHD_TP', 'PTGD', 'TGD', 'Admin'];
// Bất kỳ vai trò nào cũng có thể được chỉ đích danh theo dự án (trừ Admin — thuần kỹ thuật, không tham gia duyệt)
// (PROJECT_ROLES cũ đã bỏ — nay dùng OTHER_PROJECT_ROLES bên dưới, gộp chung màn Dự án)
const DOC_TYPE_LABEL = { contract: 'Hợp đồng', bill: 'Bill thanh toán', totrinh: 'Tờ trình chủ trương' };

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải…</div>`;

  // Gọi TẤT CẢ cùng lúc (song song) thay vì tuần tự — trước đây mỗi dòng đợi
  // xong mới gọi dòng tiếp theo, cộng dồn lại mất vài giây; giờ chỉ mất đúng
  // bằng thời gian của lần gọi chậm nhất.
  const [
    { data: templates },
    { data: allSteps },
    { data: projects, error: projErr },
    { data: departments, error: deptErr },
    { data: budgetCats, error: bcErr },
    { data: users, error },
    { data: roles },
  ] = await Promise.all([
    supabase.from('document_templates').select('id, name, doc_type, origin_scope, is_active'),
    supabase.from('template_steps').select('template_id, step_no'),
    supabase.from('projects').select('id, code, name, investor, location, project_type, unit_count, status').order('code'),
    supabase.from('departments').select('name').order('name'),
    supabase.from('budget_categories').select('code, name, group_code').order('code'),
    supabase.from('users').select('id, email, full_name, is_active').order('full_name'),
    supabase.from('user_roles').select('user_id, role_type'),
  ]);

  const stepCountMap = {};
  (allSteps || []).forEach((s) => (stepCountMap[s.template_id] = (stepCountMap[s.template_id] || 0) + 1));

  if (error) {
    container.innerHTML = `<div class="empty-note">⚠️ Không có quyền xem, hoặc lỗi: ${error.message}</div>`;
    return;
  }
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
      ${projects && projects.length ? projects.map((p) => `<tr class="click proj-row" data-id="${p.id}" data-name="${p.name}"><td class="mono">${p.code}</td><td>${p.name}</td><td>${p.investor || '—'}</td><td>${p.location || '—'}</td><td>${p.project_type || '—'}</td><td>${p.unit_count || '—'}</td><td><span class="badge idle">${statusVN[p.status] || p.status}</span></td></tr>`).join('') :
      `<tr><td colspan="7" style="text-align:center;color:var(--gray4);padding:20px">Chưa có dự án nào</td></tr>`}
      </tbody></table>`}
    </div>

    <div style="display:flex;justify-content:space-between;margin-bottom:8px;align-items:center">
      <div class="card-title" style="margin:0">Phòng ban</div>
      <button class="btn btn-primary btn-sm" id="btnNewDept">+ Tạo phòng ban mới</button>
    </div>
    <div class="card" style="margin-bottom:22px">
      ${deptErr ? `<div class="empty-note">⚠️ Lỗi: ${deptErr.message}</div>` :
      departments && departments.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px">${departments.map((d) => `<span class="code-chip dept-chip" data-name="${d.name}" style="cursor:pointer">${d.name}</span>`).join('')}</div>` :
      `<div class="empty-note">Chưa có phòng ban nào — tạo trước khi gán Trưởng phòng/Chuyên viên/PTGD theo phòng ban.</div>`}
    </div>

    <div style="display:flex;justify-content:space-between;margin-bottom:8px;align-items:center">
      <div class="card-title" style="margin:0">Mã ngân sách (danh mục mẫu — do phòng KSCP quản lý)</div>
      <button class="btn btn-primary btn-sm" id="btnNewBudgetCat">+ Tạo mã ngân sách mới</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden;margin-bottom:22px">
      ${bcErr ? `<div class="empty-note">⚠️ Lỗi: ${bcErr.message}</div>` : `
      <table><thead><tr><th>Mã</th><th>Tên</th><th>Nhóm</th></tr></thead><tbody>
      ${budgetCats && budgetCats.length ? budgetCats.map((c) => `<tr class="click bc-row" data-code="${c.code}"><td class="mono">${c.code}</td><td>${c.name}</td><td>${c.group_code || '—'}</td></tr>`).join('') :
      `<tr><td colspan="3" style="text-align:center;color:var(--gray4);padding:20px">Chưa có mã ngân sách nào</td></tr>`}
      </tbody></table>`}
      <div style="font-size:11px;color:var(--gray4);padding:8px 14px">Đây là danh mục MẪU dùng chung — khi tạo phiên bản ngân sách cho từng dự án, chỉ cần chọn đúng những mã liên quan tới dự án đó, không bắt buộc dùng hết.</div>
    </div>

    <div style="display:flex;justify-content:space-between;margin-bottom:8px;align-items:center">
      <div class="card-title" style="margin:0">Mẫu hồ sơ (luồng duyệt)</div>
      <button class="btn btn-primary btn-sm" id="btnNewTemplate">+ Tạo mẫu mới</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden;margin-bottom:22px">
      <table><thead><tr><th>Tên mẫu</th><th>Áp dụng cho loại hồ sơ</th><th>Đơn vị trình</th><th>Số bước</th></tr></thead><tbody>
      ${templates && templates.length ? templates.map((t) => `<tr class="clickable-row" data-template-id="${t.id}"><td>${t.name}</td><td><span class="badge info">${DOC_TYPE_LABEL[t.doc_type] || t.doc_type}</span></td><td>${t.origin_scope === 'site' ? 'Công trường' : 'Phòng ban'}</td><td>${stepCountMap[t.id] || 0} vai trò / ${new Set((allSteps || []).filter((s) => s.template_id === t.id).map((s) => s.step_no)).size} bước</td></tr>`).join('') :
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
  container.querySelectorAll('.proj-row').forEach((row) => row.addEventListener('click', () => openProjectAssignModal(row.dataset.id, row.dataset.name, user, () => render(container, user))));
  container.querySelector('#btnNewDept').addEventListener('click', () => openCreateDeptModal(() => render(container, user)));
  container.querySelectorAll('.dept-chip').forEach((chip) => chip.addEventListener('click', () => openEditDeptModal(chip.dataset.name, () => render(container, user))));
  container.querySelector('#btnNewBudgetCat').addEventListener('click', () => openCreateBudgetCatModal(() => render(container, user)));
  container.querySelectorAll('.bc-row').forEach((row) => row.addEventListener('click', () => openEditBudgetCatModal(row.dataset.code, () => render(container, user))));
  container.querySelector('#btnNewTemplate').addEventListener('click', () => openCreateTemplateModal(() => render(container, user)));
  container.querySelectorAll('[data-template-id]').forEach((row) => row.addEventListener('click', () => openEditTemplateModal(row.dataset.templateId, () => render(container, user))));
  container.querySelector('#btnNew').addEventListener('click', () => openCreateUserModal(user, () => render(container, user)));
  container.querySelectorAll('[data-id]').forEach((r) => r.addEventListener('click', () => openUserDetail(r.dataset.id, user, () => render(container, user))));
}

async function openCreateTemplateModal(onClose) {
  const modal = ensureModal();
  const { data: existingTemplates } = await supabase.from('document_templates').select('id, name');
  const { data: departments } = await supabase.from('departments').select('name').order('name');
  const deptOptions = `<option value="">— Mọi phòng ban —</option>${(departments || []).map((d) => `<option value="${d.name}">${d.name}</option>`).join('')}`;
  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Tạo mẫu hồ sơ mới</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="font-size:12px;background:var(--lblue);color:#1D4ED8;padding:9px 12px;border-radius:7px;margin-bottom:14px">ℹ️ Mỗi bước phải chọn ít nhất 1 vai trò — bỏ trống 1 bước sẽ khiến hồ sơ bị kẹt mãi ở bước đó, không ai duyệt được.</div>
      ${!departments || !departments.length ? `<div class="warn-box">⚠️ <div>Chưa có phòng ban nào trong hệ thống — vào khối "Phòng ban" ở trên tạo trước, nếu không sẽ không chọn được đúng Trưởng phòng/Chuyên viên/PTGD theo phòng ban.</div></div>` : ''}
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
              ${needsDept ? `<select class="step-dept form-input dept-for-${r === 'PTGD' ? 'ptgd' : 'office'}" data-step="${step}" data-role="${r}" style="width:140px;padding:3px 7px;font-size:11px">${deptOptions}</select>` : ''}
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

async function openEditTemplateModal(templateId, onClose) {
  const modal = ensureModal();
  const { data: tpl } = await supabase.from('document_templates').select('*').eq('id', templateId).single();
  if (!tpl) return toast('Không tải được mẫu hồ sơ', 'error');
  const { data: currentSteps } = await supabase.from('template_steps').select('step_no, role_type, department').eq('template_id', templateId);
  const { data: departments } = await supabase.from('departments').select('name').order('name');
  const deptOptions = `<option value="">— Mọi phòng ban —</option>${(departments || []).map((d) => `<option value="${d.name}">${d.name}</option>`).join('')}`;
  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Sửa mẫu hồ sơ — ${tpl.name}</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="font-size:12px;background:var(--lblue);color:#1D4ED8;padding:9px 12px;border-radius:7px;margin-bottom:14px">ℹ️ Mỗi bước phải chọn ít nhất 1 vai trò — bỏ trống 1 bước sẽ khiến hồ sơ bị kẹt mãi ở bước đó, không ai duyệt được. Đổi ở đây chỉ ảnh hưởng hồ sơ CHƯA tới bước bị đổi — hồ sơ đã duyệt qua bước đó giữ nguyên lịch sử.</div>
      <div style="margin-bottom:13px"><label class="form-label">Tên mẫu *</label><input type="text" id="fName" class="form-input" value="${tpl.name}"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:13px">
        <div><label class="form-label">Áp dụng cho loại hồ sơ *</label>
          <select id="fDocType" class="form-input">
            <option value="contract" ${tpl.doc_type === 'contract' ? 'selected' : ''}>Hợp đồng</option>
            <option value="bill" ${tpl.doc_type === 'bill' ? 'selected' : ''}>Bill thanh toán</option>
            <option value="totrinh" ${tpl.doc_type === 'totrinh' ? 'selected' : ''}>Tờ trình chủ trương</option>
          </select></div>
        <div><label class="form-label">Đơn vị trình *</label>
          <select id="fScope" class="form-input">
            <option value="site" ${tpl.origin_scope === 'site' ? 'selected' : ''}>Công trường</option>
            <option value="department" ${tpl.origin_scope === 'department' ? 'selected' : ''}>Phòng ban</option>
          </select>
          <div style="font-size:11px;color:var(--gray4);margin-top:4px">Công trường: PTGD phân theo dự án. Phòng ban: PTGD phân theo phòng ban (ô bên dưới).</div></div>
      </div>
      <div style="margin-bottom:13px"><label class="form-label">Mô tả</label><input type="text" id="fDesc" class="form-input" value="${tpl.description || ''}"></div>
      <div style="margin-bottom:13px"><label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="fActive" ${tpl.is_active !== false ? 'checked' : ''}> Đang hoạt động (bỏ tick để ngừng dùng mẫu này — hồ sơ đang chọn mẫu này không bị ảnh hưởng, chỉ ẩn khỏi danh sách chọn khi tạo hồ sơ mới)</label></div>
      ${[1, 2, 3, 4].map((step) => `
        <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Bước ${step}</div>
        <div class="card" style="padding:10px 14px;display:grid;grid-template-columns:1fr 1fr;gap:6px 10px">
          ${ALL_ROLES.map((r) => {
            const needsDept = r === 'TruongPhongChucNang' || r === 'ChuyenVienPhongBan' || r === 'PTGD';
            const existing = (currentSteps || []).find((s) => s.step_no === step && s.role_type === r);
            return `<label style="font-size:12.5px;display:flex;align-items:center;gap:6px;cursor:pointer">
              <input type="checkbox" class="step-role" data-step="${step}" data-role="${r}" ${existing ? 'checked' : ''}>${r}
              ${needsDept ? `<select class="step-dept form-input dept-for-${r === 'PTGD' ? 'ptgd' : 'office'}" data-step="${step}" data-role="${r}" style="width:140px;padding:3px 7px;font-size:11px">${deptOptions}</select>` : ''}
            </label>`;
          }).join('')}
        </div>`).join('')}
    </div>
    <div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">💾 Lưu thay đổi</button></div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  // Điền sẵn đúng phòng ban đã ghi cho từng dòng (phải làm sau khi HTML đã dựng xong)
  (currentSteps || []).forEach((s) => {
    if (!s.department) return;
    const dept = modal.querySelector(`.step-dept[data-step="${s.step_no}"][data-role="${s.role_type}"]`);
    if (dept) dept.value = s.department;
  });

  function togglePtgdDept() {
    const isDept = modal.querySelector('#fScope').value === 'department';
    modal.querySelectorAll('.dept-for-ptgd').forEach((el) => {
      el.style.display = isDept ? '' : 'none';
      if (!isDept) el.value = '';
    });
  }
  modal.querySelector('#fScope').addEventListener('change', togglePtgdDept);
  togglePtgdDept();

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const name = modal.querySelector('#fName').value.trim();
    const doc_type = modal.querySelector('#fDocType').value;
    const origin_scope = modal.querySelector('#fScope').value;
    const description = modal.querySelector('#fDesc').value.trim();
    const is_active = modal.querySelector('#fActive').checked;
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
    const { error } = await supabase.from('document_templates').update({ name, doc_type, origin_scope, description, is_active }).eq('id', templateId);
    if (error) return toast('Lỗi lưu: ' + error.message, 'error');

    // Xóa hết bước cũ, ghi lại đúng theo trạng thái tick hiện tại — đơn giản, chắc chắn
    // đồng bộ đúng. Hồ sơ ĐÃ tạo trước đó không bị ảnh hưởng (approval_assignments là
    // dữ liệu riêng, đã "chụp ảnh" sẵn lúc tạo, không đọc lại template_steps sau này).
    await supabase.from('template_steps').delete().eq('template_id', templateId);
    const { error: stepErr } = await supabase.from('template_steps').insert(checked.map((c) => ({ template_id: templateId, step_no: c.step_no, role_type: c.role_type, department: c.department })));
    if (stepErr) return toast('Đã lưu mẫu nhưng lỗi lưu các bước: ' + stepErr.message, 'error');

    toast('Đã lưu thay đổi mẫu hồ sơ', 'success');
    closeModal(modal, onClose);
  });
}

async function openCreateBudgetCatModal(onClose) {
  const modal = ensureModal();
  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Tạo mã ngân sách mới</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="margin-bottom:13px"><label class="form-label">Mã * (viết liền không dấu, vd NCC_ThepXayDung)</label><input type="text" id="fCode" class="form-input"></div>
      <div style="margin-bottom:13px"><label class="form-label">Tên đầy đủ *</label><input type="text" id="fName" class="form-input" placeholder="VD: Cung cấp thép xây dựng"></div>
      <div style="margin-bottom:13px"><label class="form-label">Nhóm chi phí</label><input type="text" id="fGroup" class="form-input" placeholder="VD: B.2"></div>
    </div>
    <div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">Lưu mã ngân sách</button></div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const code = modal.querySelector('#fCode').value.trim();
    const name = modal.querySelector('#fName').value.trim();
    const group_code = modal.querySelector('#fGroup').value.trim() || null;
    if (!code || !name) return toast('Điền đủ Mã và Tên', 'error');
    loading(true);
    const { error } = await supabase.from('budget_categories').insert({ code, name, group_code });
    if (error) return toast('Lỗi lưu (có thể mã đã tồn tại): ' + error.message, 'error');
    toast('Đã tạo mã ngân sách mới', 'success');
    closeModal(modal, onClose);
  });
}

async function openEditBudgetCatModal(code, onClose) {
  const modal = ensureModal();
  const { data: cat } = await supabase.from('budget_categories').select('*').eq('code', code).single();
  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Mã ngân sách: ${code}</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="margin-bottom:13px"><label class="form-label">Mã (không đổi được)</label><input type="text" class="form-input" value="${code}" disabled style="background:var(--gray1)"></div>
      <div style="margin-bottom:13px"><label class="form-label">Tên đầy đủ</label><input type="text" id="fName" class="form-input" value="${cat?.name || ''}"></div>
      <div style="margin-bottom:13px"><label class="form-label">Nhóm chi phí</label><input type="text" id="fGroup" class="form-input" value="${cat?.group_code || ''}"></div>
    </div>
    <div class="panel-footer">
      <button class="btn btn-danger" id="btnDelete">🗑️ Xóa mã này</button>
      <button class="btn btn-primary" id="btnSave" style="margin-left:auto">💾 Lưu thay đổi</button>
    </div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const name = modal.querySelector('#fName').value.trim();
    const group_code = modal.querySelector('#fGroup').value.trim() || null;
    if (!name) return toast('Điền tên', 'error');
    loading(true);
    const { error } = await supabase.from('budget_categories').update({ name, group_code }).eq('code', code);
    if (error) return toast('Lỗi lưu: ' + error.message, 'error');
    toast('Đã lưu thay đổi', 'success');
    closeModal(modal, onClose);
  });

  modal.querySelector('#btnDelete').addEventListener('click', async () => {
    if (!confirm(`Xóa mã ngân sách "${code}"? Chỉ xóa được nếu chưa dùng ở ngân sách/hợp đồng/bill nào.`)) return;
    loading(true);
    const { error } = await supabase.from('budget_categories').delete().eq('code', code);
    if (error) return toast(error.message, 'error');
    toast('Đã xóa mã ngân sách', 'success');
    closeModal(modal, onClose);
  });
}

async function openEditDeptModal(name, onClose) {
  const modal = ensureModal();
  const { data: holders } = await supabase
    .from('user_roles')
    .select('id, role_type, users(full_name, email)')
    .eq('department', name)
    .in('role_type', ['TruongPhongChucNang', 'PTGD']);
  const { data: users } = await supabase.from('users').select('id, full_name, email').eq('is_active', true).order('full_name');
  const userOptions = `<option value="">— Chọn người —</option>${(users || []).map((u) => `<option value="${u.id}">${u.full_name} (${u.email})</option>`).join('')}`;
  const roleLabel = { TruongPhongChucNang: 'Trưởng phòng', PTGD: 'PTGD phụ trách' };

  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Phòng ban: ${name}</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="margin-bottom:13px"><label class="form-label">Tên phòng ban</label><input type="text" id="fName" class="form-input" value="${name}"></div>
      <div style="font-size:11.5px;color:var(--gray4);margin-bottom:16px">Đổi tên ở đây sẽ tự cập nhật lại hết những chỗ đang dùng tên cũ (người dùng, mẫu hồ sơ) — không cần sửa tay từng nơi.</div>

      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Người phụ trách phòng ban này</div>
      <div class="card" style="padding:12px 14px">
        <div id="holderList" style="margin-bottom:10px">
          ${(holders || []).length ? holders.map((h) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--gray1);font-size:13px">
            <span><span class="code-chip">${roleLabel[h.role_type]}</span> ${h.users?.full_name} <span style="color:var(--gray4)">(${h.users?.email})</span></span>
            <span data-rm-holder="${h.id}" style="cursor:pointer;color:var(--red);font-size:12px">Gỡ</span>
          </div>`).join('') : '<div style="color:var(--gray4);font-size:12px">Chưa gán ai</div>'}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px">
          <select id="fHolderUser" class="form-input">${userOptions}</select>
          <select id="fHolderRole" class="form-input"><option value="TruongPhongChucNang">Trưởng phòng</option><option value="PTGD">PTGD phụ trách</option></select>
          <button class="btn btn-sm btn-secondary" id="btnAddHolder">+ Thêm</button>
        </div>
      </div>
    </div>
    <div class="panel-footer">
      <button class="btn btn-danger" id="btnDelete">🗑️ Xóa phòng ban</button>
      <button class="btn btn-primary" id="btnSave" style="margin-left:auto">💾 Lưu tên mới</button>
    </div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  modal.querySelector('#btnAddHolder').addEventListener('click', async () => {
    const userId = modal.querySelector('#fHolderUser').value;
    const role_type = modal.querySelector('#fHolderRole').value;
    if (!userId) return toast('Chọn người trước', 'error');
    loading(true);
    const { error } = await supabase.from('user_roles').insert({ user_id: userId, role_type, department: name });
    if (error) return toast('Lỗi (có thể đã gán rồi): ' + error.message, 'error');
    toast('Đã thêm người phụ trách', 'success');
    openEditDeptModal(name, onClose);
  });

  modal.querySelectorAll('[data-rm-holder]').forEach((el) =>
    el.addEventListener('click', async () => {
      await supabase.from('user_roles').delete().eq('id', el.dataset.rmHolder);
      toast('Đã gỡ', 'success');
      openEditDeptModal(name, onClose);
    }),
  );

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const newName = modal.querySelector('#fName').value.trim();
    if (!newName) return toast('Điền tên phòng ban', 'error');
    if (newName === name) return closeModal(modal, onClose);
    loading(true);
    const { error } = await supabase.from('departments').update({ name: newName }).eq('name', name);
    if (error) return toast('Lỗi đổi tên (có thể tên mới đã tồn tại): ' + error.message, 'error');
    toast('Đã đổi tên phòng ban', 'success');
    closeModal(modal, onClose);
  });

  modal.querySelector('#btnDelete').addEventListener('click', async () => {
    if (!confirm(`Xóa phòng ban "${name}"? Chỉ xóa được nếu chưa ai/mẫu hồ sơ nào đang dùng.`)) return;
    loading(true);
    const { error } = await supabase.from('departments').delete().eq('name', name);
    if (error) return toast(error.message, 'error');
    toast('Đã xóa phòng ban', 'success');
    closeModal(modal, onClose);
  });
}

// Các vai trò còn lại ngoài CHT/GĐDA/PTGD (những vai trò này đích danh theo kiểu
// "danh sách nhiều người", không phải "1 người thay 1 người")
const OTHER_PROJECT_ROLES = ['QS', 'TGD', 'ChuyenVienPhongBan', 'TruongPhongChucNang', 'PhapChe_CV', 'PhapChe_TP', 'KeToan_Vien', 'KeToan_Truong', 'QLCPHD_CV', 'QLCPHD_TP'];

async function openProjectAssignModal(projectId, projectName, currentUser, onClose) {
  const modal = ensureModal();
  const today = new Date().toISOString().slice(0, 10);
  const { data: assignments, error: assignErr } = await supabase
    .from('project_role_assignments')
    .select('id, role_type, user_id, effective_from, users!user_id(full_name, email)')
    .eq('project_id', projectId)
    .or(`effective_to.is.null,effective_to.gte.${today}`); // khớp đúng logic "còn hiệu lực" đang dùng để định tuyến — không chỉ mỗi effective_to để trống
  if (assignErr) console.error('Lỗi tải người phụ trách:', assignErr);
  const { data: users } = await supabase.from('users').select('id, full_name, email').eq('is_active', true).order('full_name');
  const userOptions = `<option value="">— Chọn người —</option>${(users || []).map((u) => `<option value="${u.id}">${u.full_name} (${u.email})</option>`).join('')}`;

  const roleLabel = { CHT: 'Chỉ huy trưởng', GDDA: 'Giám đốc dự án', PTGD: 'Phó Tổng Giám đốc' };
  const currentByRole = {};
  const otherAssignments = [];
  (assignments || []).forEach((a) => {
    if (a.role_type in roleLabel) currentByRole[a.role_type] = a;
    else otherAssignments.push(a);
  });

  const rows = Object.keys(roleLabel)
    .map((role) => {
      const cur = currentByRole[role];
      return `<div style="margin-bottom:14px">
      <label class="form-label">${roleLabel[role]}</label>
      <div style="font-size:12.5px;color:${cur ? 'var(--gray8)' : 'var(--gray4)'};margin-bottom:6px">${cur ? `Hiện tại: <b>${cur.users?.full_name}</b> (${cur.users?.email}) — từ ${new Date(cur.effective_from).toLocaleDateString('vi-VN')}` : 'Chưa gán'}</div>
      <div style="display:flex;gap:8px">
        <select class="form-input reassign-select" data-role="${role}" style="flex:1">${userOptions}</select>
        <button class="btn btn-sm btn-secondary reassign-btn" data-role="${role}">Đổi</button>
      </div>
    </div>`;
    })
    .join('');

  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Người phụ trách dự án — ${projectName}</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="font-size:12px;background:var(--lblue);color:#1D4ED8;padding:9px 12px;border-radius:7px;margin-bottom:16px">ℹ️ Đổi người (CHT/GĐDA/PTGD) sẽ tự động chuyển giao hồ sơ đang chờ duyệt của dự án này sang người mới (nếu có), không bị treo.</div>
      ${rows}
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5);margin-top:20px">Các vai trò khác — đích danh theo dự án (nhiều người/vai trò cùng lúc)</div>
      <div style="font-size:11.5px;color:var(--gray4);margin-bottom:8px">QS bắt buộc phải gán mới trình được hồ sơ cho dự án này. Các vai trò khác (Pháp chế, Kế toán, QLCP&HĐ...) không bắt buộc — nếu không chỉ đích danh ở đây, hồ sơ dự án đó tự động gửi cho cả nhóm giữ vai trò đó.</div>
      <div class="card" style="padding:12px 14px">
        <div id="otherRolesList" style="margin-bottom:10px">
          ${otherAssignments.length ? otherAssignments.map((a) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--gray1);font-size:13px">
            <span><span class="code-chip">${a.role_type}</span> ${a.users?.full_name} <span style="color:var(--gray4)">(${a.users?.email})</span></span>
            <span data-rm-other="${a.id}" data-role-type="${a.role_type}" style="cursor:pointer;color:var(--red);font-size:12px">Gỡ</span>
          </div>`).join('') : '<div style="color:var(--gray4);font-size:12px">Chưa đích danh thêm ai.</div>'}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px">
          <select id="fOtherRole" class="form-input">${OTHER_PROJECT_ROLES.map((r) => `<option value="${r}">${r}</option>`).join('')}</select>
          <select id="fOtherUser" class="form-input">${userOptions}</select>
          <button class="btn btn-sm btn-secondary" id="btnAddOther">+ Thêm</button>
        </div>
      </div>
    </div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  modal.querySelectorAll('.reassign-btn').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const role = btn.dataset.role;
      const select = modal.querySelector(`.reassign-select[data-role="${role}"]`);
      const newUserId = select.value;
      if (!newUserId) return toast('Chọn người trước khi đổi', 'error');

      loading(true);
      const { data, error } = await supabase.rpc('fn_reassign_project_role', {
        p_project_id: projectId, p_role_type: role, p_new_user_id: newUserId, p_actor_id: currentUser.id,
      });
      if (error) return toast('Lỗi: ' + error.message, 'error');
      if (data.old_user_id) {
        toast(`Đã thay ${roleLabel[role]} — chuyển giao ${data.transferred_count} hồ sơ đang chờ duyệt sang người mới`, 'success');
      } else {
        toast(`Đã gán ${roleLabel[role]}`, 'success');
      }
      openProjectAssignModal(projectId, projectName, currentUser, onClose);
    }),
  );

  modal.querySelector('#btnAddOther').addEventListener('click', async () => {
    const userId = modal.querySelector('#fOtherUser').value;
    const role_type = modal.querySelector('#fOtherRole').value;
    if (!userId) return toast('Chọn người trước', 'error');
    loading(true);
    const { error } = await supabase.from('project_role_assignments').insert({
      project_id: projectId, user_id: userId, role_type, effective_from: new Date().toISOString().slice(0, 10),
    });
    if (error) return toast('Lỗi (có thể đã gán rồi): ' + error.message, 'error');

    // Hồ sơ nào đang chờ đúng vai trò này ở bước hiện tại (chưa ai duyệt) sẽ tự cập
    // nhật sang đúng người mới nhất — hồ sơ đã duyệt rồi giữ nguyên, không đụng tới
    const { data: resyncCount } = await supabase.rpc('fn_resync_pending_assignments', { p_project_id: projectId, p_role_type: role_type });
    toast(`Đã thêm${resyncCount ? ` — cập nhật lại ${resyncCount} hồ sơ đang chờ duyệt` : ''}`, 'success');
    openProjectAssignModal(projectId, projectName, currentUser, onClose);
  });

  modal.querySelectorAll('[data-rm-other]').forEach((el) =>
    el.addEventListener('click', async () => {
      loading(true);
      const roleType = el.dataset.roleType;
      await supabase.from('project_role_assignments').update({ effective_to: new Date(Date.now() - 86400000).toISOString().slice(0, 10) }).eq('id', el.dataset.rmOther);

      let resyncCount = 0;
      if (roleType) {
        const { data } = await supabase.rpc('fn_resync_pending_assignments', { p_project_id: projectId, p_role_type: roleType });
        resyncCount = data || 0;
      }
      toast(`Đã gỡ${resyncCount ? ` — cập nhật lại ${resyncCount} hồ sơ đang chờ duyệt (rơi về cả nhóm nếu chưa ai đích danh khác)` : ''}`, 'success');
      openProjectAssignModal(projectId, projectName, currentUser, onClose);
    }),
  );
}

async function openCreateDeptModal(onClose) {
  const modal = ensureModal();
  const { data: users } = await supabase.from('users').select('id, full_name, email').eq('is_active', true).order('full_name');
  const userOptions = `<option value="">— Chưa gán, làm sau —</option>${(users || []).map((u) => `<option value="${u.id}">${u.full_name} (${u.email})</option>`).join('')}`;

  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Tạo phòng ban mới</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="margin-bottom:13px"><label class="form-label">Tên phòng ban *</label><input type="text" id="fDeptName" class="form-input" placeholder="VD: Thiết bị"></div>
      <div style="font-size:11.5px;color:var(--gray4);margin-bottom:16px">Đặt tên ngắn gọn, thống nhất — tên này sẽ hiện trong danh sách chọn khi gán vai trò cho người dùng và khi tạo Mẫu hồ sơ.</div>
      <div style="margin-bottom:13px"><label class="form-label">Trưởng phòng (không bắt buộc — có thể gán sau)</label>
        <select id="fTruongPhong" class="form-input">${userOptions}</select></div>
      <div style="margin-bottom:13px"><label class="form-label">PTGD phụ trách phòng này (không bắt buộc)</label>
        <select id="fPtgd" class="form-input">${userOptions}</select>
        <div style="font-size:11px;color:var(--gray4);margin-top:4px">Chỉ áp dụng cho luồng duyệt Mẫu hồ sơ "Phòng ban" — PTGD công trường vẫn phân theo dự án như cũ.</div></div>
    </div>
    <div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">Lưu phòng ban</button></div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const name = modal.querySelector('#fDeptName').value.trim();
    const truongPhongId = modal.querySelector('#fTruongPhong').value;
    const ptgdId = modal.querySelector('#fPtgd').value;
    if (!name) return toast('Điền tên phòng ban', 'error');

    loading(true);
    const { error } = await supabase.from('departments').insert({ name });
    if (error) return toast('Lỗi lưu (có thể phòng ban đã tồn tại): ' + error.message, 'error');

    if (truongPhongId) {
      await supabase.from('user_roles').insert({ user_id: truongPhongId, role_type: 'TruongPhongChucNang', department: name }).select();
    }
    if (ptgdId) {
      await supabase.from('user_roles').insert({ user_id: ptgdId, role_type: 'PTGD', department: name }).select();
    }

    toast('Đã tạo phòng ban mới' + (truongPhongId || ptgdId ? ' và gán người phụ trách' : ''), 'success');
    closeModal(modal, onClose);
  });
}

async function openCreateProjectModal(onClose) {
  const modal = ensureModal();
  const { data: users } = await supabase.from('users').select('id, full_name, email').eq('is_active', true).order('full_name');
  const userOptions = `<option value="">— Chưa gán, làm sau —</option>${(users || []).map((u) => `<option value="${u.id}">${u.full_name} (${u.email})</option>`).join('')}`;

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
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Người phụ trách (không bắt buộc — có thể gán sau)</div>
      <div class="card" style="padding:12px 14px">
        <div style="margin-bottom:10px"><label class="form-label">Chỉ huy trưởng (CHT)</label><select id="fCht" class="form-input">${userOptions}</select></div>
        <div style="margin-bottom:10px"><label class="form-label">Giám đốc dự án (GĐDA)</label><select id="fGdda" class="form-input">${userOptions}</select></div>
        <div><label class="form-label">Phó Tổng Giám đốc (PTGD)</label><select id="fPtgd" class="form-input">${userOptions}</select></div>
      </div>
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
    const { data: newProject, error } = await supabase.from('projects').insert({
      code, name,
      investor: modal.querySelector('#fInvestor').value.trim() || null,
      location: modal.querySelector('#fLocation').value.trim() || null,
      project_type: modal.querySelector('#fType').value.trim() || null,
      unit_count: modal.querySelector('#fUnits').value ? Number(modal.querySelector('#fUnits').value) : null,
      start_date: modal.querySelector('#fStart').value || null,
      status: 'active',
    }).select('id').single();
    if (error) return toast('Lỗi lưu dự án (mã có thể đã tồn tại): ' + error.message, 'error');

    const assignments = [
      { sel: '#fCht', role: 'CHT' },
      { sel: '#fGdda', role: 'GDDA' },
      { sel: '#fPtgd', role: 'PTGD' },
    ];
    let assignedCount = 0;
    for (const a of assignments) {
      const userId = modal.querySelector(a.sel).value;
      if (userId) {
        await supabase.from('project_role_assignments').insert({ project_id: newProject.id, user_id: userId, role_type: a.role, effective_from: new Date().toISOString().slice(0, 10) });
        assignedCount++;
      }
    }

    toast('Đã tạo dự án mới' + (assignedCount ? ` và gán ${assignedCount} người phụ trách` : ''), 'success');
    closeModal(modal, onClose);
  });
}

async function openUserDetail(id, currentUser, onClose) {
  const modal = ensureModal();
  modal.innerHTML = `<div class="panel-box"><div class="empty-note">Đang tải…</div></div>`;
  showModal(modal, onClose);

  const { data: u } = await supabase.from('users').select('*').eq('id', id).single();
  const { data: myRoles } = await supabase.from('user_roles').select('id, role_type, department').eq('user_id', id);
  const { data: departments } = await supabase.from('departments').select('name').order('name');

  const box = modal.querySelector('.panel-box');
  box.innerHTML = `
    <div class="panel-header"><div><div>${u.full_name}</div><div class="meta">${u.email}${u.job_title ? ' · ' + u.job_title : ''}</div></div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="margin-bottom:16px">
        <label class="form-label">Trạng thái tài khoản</label>
        <button class="btn btn-sm ${u.is_active ? 'btn-danger' : 'btn-secondary'}" id="btnToggleActive">${u.is_active ? '🔒 Khóa tài khoản' : '✓ Kích hoạt lại'}</button>
      </div>

      <div style="margin-bottom:16px"><label class="form-label">Chức danh (không bắt buộc — chỉ để tham khảo, không ảnh hưởng luồng duyệt)</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="fJobTitle" class="form-input" value="${u.job_title || ''}" placeholder="VD: Phó phòng Vật tư">
          <button class="btn btn-sm btn-secondary" id="btnSaveJobTitle">Lưu</button>
        </div>
      </div>

      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Vai trò hệ thống</div>
      <div class="card">
        <div id="roleList" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">
          ${(myRoles || []).map((r) => `<span class="code-chip">${r.role_type}${r.department ? ' — ' + r.department : ''} <span data-rm-role="${r.id}" style="cursor:pointer;color:var(--red);font-weight:700;margin-left:3px">✕</span></span>`).join('') || '<span style="color:var(--gray4);font-size:12px">Chưa có vai trò nào</span>'}
        </div>
        <div style="display:flex;gap:8px">
          <select id="fAddRole" class="form-input">${ALL_ROLES.map((r) => `<option value="${r}">${r}</option>`).join('')}</select>
          <select id="fAddRoleDept" class="form-input" style="max-width:200px">
            <option value="">— Không thuộc phòng ban —</option>
            ${(departments || []).map((d) => `<option value="${d.name}">${d.name}</option>`).join('')}
          </select>
          <button class="btn btn-sm btn-secondary" id="btnAddRole">+ Thêm</button>
        </div>
      </div>

    </div>`;

  box.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  box.querySelector('#btnSaveJobTitle').addEventListener('click', async () => {
    const job_title = box.querySelector('#fJobTitle').value.trim() || null;
    loading(true);
    const { error } = await supabase.from('users').update({ job_title }).eq('id', id);
    if (error) return toast('Lỗi lưu: ' + error.message, 'error');
    toast('Đã lưu chức danh', 'success');
    openUserDetail(id, currentUser, onClose);
  });

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
}

async function openCreateUserModal(currentUser, onClose) {
  const modal = ensureModal();
  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Thêm người dùng mới</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="font-size:12px;background:var(--lblue);color:#1D4ED8;padding:9px 12px;border-radius:7px;margin-bottom:14px">ℹ️ Nhập đúng email Outlook công ty — người này đăng nhập bằng chính email đó, không có mật khẩu riêng.</div>
      <div style="margin-bottom:13px"><label class="form-label">Email Outlook công ty *</label><input type="email" id="fEmail" class="form-input" placeholder="ten.nhanvien@velaec.vn"></div>
      <div style="margin-bottom:13px"><label class="form-label">Họ tên *</label><input type="text" id="fName" class="form-input"></div>
      <div style="margin-bottom:13px"><label class="form-label">Chức danh (không bắt buộc — chỉ để tham khảo, không ảnh hưởng luồng duyệt)</label><input type="text" id="fJobTitle" class="form-input" placeholder="VD: Phó phòng Vật tư"></div>
      <div style="margin-bottom:13px"><label class="form-label">Điện thoại</label><input type="text" id="fPhone" class="form-input"></div>
    </div>
    <div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">Lưu — gán vai trò ở bước sau</button></div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const email = modal.querySelector('#fEmail').value.trim();
    const full_name = modal.querySelector('#fName').value.trim();
    const job_title = modal.querySelector('#fJobTitle').value.trim() || null;
    const phone = modal.querySelector('#fPhone').value.trim() || null;
    if (!email || !full_name) return toast('Điền đủ email và họ tên', 'error');

    loading(true);
    const { error } = await supabase.from('users').insert({ email, full_name, job_title, phone });
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
  modal.scrollTop = 0; // đưa về đúng đầu trang — phòng trình duyệt di động giữ vị trí cuộn cũ
  pushModalHistory();
  // Cố tình KHÔNG đóng khi bấm ra ngoài — tránh mất dữ liệu đang nhập nếu lỡ tay bấm trượt.
  // Chỉ đóng bằng nút X (hoặc nút Hủy/nút quay lại chi tiết).
}
function closeModal(modal, onClose) {
  modal.classList.remove('show');
  popModalHistory();
  if (onClose) onClose();
}
