// ============================================================
// hopdong.js — Module Hợp đồng đầu vào (NTP/NCC)
// ============================================================
import { supabase } from '../core/config.js';
import { fmt, toast, loading, statusBadge } from '../core/utils.js';
import { loadApprovalState, railHtml, timelineHtml, actionFooterHtml, wireActions, resolveDefaultTemplates } from '../core/approvalUI.js';
import { renderAttachments } from '../core/attachments.js';

let VIEW_PROJECT = 'ALL';

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải…</div>`;

  const { data: projects } = await supabase.from('projects').select('id, code, name').order('code');
  let q = supabase
    .from('contracts')
    .select('id, doc_number, contract_type, value, status, current_step, to_trinh_id, project_id, created_at, partners(name)')
    .order('created_at', { ascending: false });
  if (VIEW_PROJECT !== 'ALL') q = q.eq('project_id', VIEW_PROJECT);
  const { data: contracts, error } = await q;

  if (error) {
    container.innerHTML = `<div class="empty-note">⚠️ Lỗi tải dữ liệu: ${error.message}</div>`;
    return;
  }

  // Ưu tiên: chưa xong (khác 'active') lên trước, trong nhóm thì mới nhất trước
  const sorted = [...(contracts || [])].sort((a, b) => {
    const ad = a.status === 'active' ? 1 : 0;
    const bd = b.status === 'active' ? 1 : 0;
    if (ad !== bd) return ad - bd;
    return new Date(b.created_at) - new Date(a.created_at);
  });

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;margin-bottom:12px;gap:10px;flex-wrap:wrap">
      <select class="btn btn-secondary" id="projFilter">
        <option value="ALL" ${VIEW_PROJECT === 'ALL' ? 'selected' : ''}>Tất cả dự án</option>
        ${(projects || []).map((p) => `<option value="${p.id}" ${VIEW_PROJECT === p.id ? 'selected' : ''}>${p.code} — ${p.name}</option>`).join('')}
      </select>
      <button class="btn btn-primary" id="btnNew">+ Trình hợp đồng mới</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden"><table><thead><tr><th>Số hồ sơ</th><th>Đối tác</th><th>Loại</th><th>Giá trị</th><th>Trạng thái</th></tr></thead><tbody>
    ${sorted.length ? sorted.map((c) => `<tr class="click" data-id="${c.id}"><td class="mono">${c.doc_number}</td><td>${c.partners?.name || '—'}</td><td>${c.contract_type}</td>
    <td class="mono">${fmt(c.value)}</td><td>${statusBadge(c.status)}</td></tr>`).join('') :
    `<tr><td colspan="5" style="text-align:center;color:var(--gray4);padding:20px">Chưa có hợp đồng nào</td></tr>`}
    </tbody></table></div>`;

  container.querySelector('#projFilter').addEventListener('change', (e) => {
    VIEW_PROJECT = e.target.value;
    render(container, user);
  });
  container.querySelector('#btnNew').addEventListener('click', () => openCreateModal(user, () => render(container, user)));
  container.querySelectorAll('[data-id]').forEach((r) => r.addEventListener('click', () => openDetail(r.dataset.id, user, () => render(container, user))));
}

export async function openDetail(id, user, onClose) {
  const modal = ensureModal();
  modal.innerHTML = `<div class="panel-box"><div class="empty-note">Đang tải…</div></div>`;
  showModal(modal, onClose);

  const { data: c } = await supabase
    .from('contracts')
    .select('*, partners(name), projects(name), to_trinh_chu_truong(doc_number, title), contract_budget_lines(budget_code, value)')
    .eq('id', id)
    .single();
  if (!c) {
    modal.querySelector('.panel-box').innerHTML = `<div class="empty-note">Không tải được hồ sơ (có thể không còn quyền xem).</div>`;
    return;
  }
  const { assignments, logs } = await loadApprovalState('contract', id);

  const canEditNow = c.created_by === user.id && ['draft', 'rejected'].includes(c.status);
  const box = modal.querySelector('.panel-box');
  box.innerHTML = `
    <div class="panel-header"><div><div>${c.doc_number}</div><div class="meta">${c.contract_type} · ${c.partners?.name || '—'}</div></div>
      <div style="display:flex;gap:6px;align-items:center">
        ${canEditNow ? `<button class="btn btn-sm btn-secondary" id="btnEdit">✏️ Sửa</button>` : ''}
        <button class="panel-close" id="pClose">✕</button>
      </div></div>
    <div class="panel-body">
      ${c.budget_overrun_flag ? `<div class="warn-box">⚠️ <div><b>Case 2 — Cam kết đã vượt Ngân sách phân bổ.</b> Không dùng phụ lục hợp đồng cho trường hợp này — cần QLCP&HĐ ban hành phiên bản ngân sách mới.</div></div>` : ''}
      ${c.pending_addendum_flag ? `<div class="warn-box">⚠️ <div><b>Case 1 — Đang chờ bổ sung phụ lục hợp đồng</b> (bill đã vượt giá trị hợp đồng gốc).</div></div>` : ''}
      <div class="kv">
        <div class="k">Dự án</div><div class="v">${c.projects?.name || '—'}</div>
        <div class="k">Giá trị hợp đồng</div><div class="v mono" style="font-weight:700">${fmt(c.value)} ₫</div>
        <div class="k">Tờ trình căn cứ</div><div class="v">${c.to_trinh_chu_truong ? `<span class="code-chip">${c.to_trinh_chu_truong.doc_number}</span>` : '<span style="color:var(--amber);font-size:12px">⚠️ Chưa gắn tờ trình chủ trương</span>'}</div>
        <div class="k">Trạng thái</div><div class="v">${statusBadge(c.status)}</div>
        <div class="k">Chia mã ngân sách</div><div class="v">${(c.contract_budget_lines || []).map((l) => `<div class="budget-line"><span class="code-chip">${l.budget_code}</span><span class="mono">${fmt(l.value)} ₫</span></div>`).join('') || '<span style="color:var(--gray4)">Chưa chia</span>'}</div>
      </div>
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Hồ sơ đính kèm</div>
      <div class="card" id="attachArea"></div>
      ${c.status !== 'draft' ? `<div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Luồng phê duyệt</div>${railHtml(assignments, c.current_step)}
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5);margin-top:20px">Lịch sử</div>${timelineHtml(logs)}` : `<div class="empty-note">Hồ sơ đang ở trạng thái nháp — bấm Trình duyệt để bắt đầu luồng phê duyệt.</div>`}
    </div>
    ${actionFooterHtml(c, 'contract', user, assignments)}
  `;

  box.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));
  box.querySelector('#btnEdit')?.addEventListener('click', () => openEditModal(c, user, onClose));
  const canEditAttach = canEditNow;
  renderAttachments(box.querySelector('#attachArea'), 'contract', id, user.id, canEditAttach);
  wireActions(box, 'contract', id, c.current_step, assignments, () => {
    closeModal(modal, onClose);
  });
}

async function openEditModal(c, user, onClose) {
  const modal = ensureModal();
  const { data: projects } = await supabase.from('projects').select('id, code, name').order('code');
  const { data: partners } = await supabase.from('partners').select('id, name, mst, abbr').order('name');
  const { data: categories } = await supabase.from('budget_categories').select('code, name').order('code');
  const { data: templates } = await supabase.from('document_templates').select('id, name').eq('doc_type', 'contract');
  const { data: toTrinhList } = await supabase.from('to_trinh_chu_truong').select('id, doc_number, title').order('doc_number');
  const { data: currentLines } = await supabase.from('contract_budget_lines').select('budget_code').eq('contract_id', c.id);
  const currentBudgetCode = currentLines?.[0]?.budget_code || '';

  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Sửa hợp đồng — ${c.doc_number}</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="margin-bottom:13px"><label class="form-label">Dự án</label>
        <select id="fProject" class="form-input">${(projects || []).map((p) => `<option value="${p.id}" ${p.id === c.project_id ? 'selected' : ''}>${p.code} — ${p.name}</option>`).join('')}</select></div>
      <div style="margin-bottom:13px"><label class="form-label">Đối tác (NTP/NCC)</label>
        <select id="fPartner" class="form-input">${(partners || []).map((p) => `<option value="${p.id}" ${p.id === c.partner_id ? 'selected' : ''}>${p.name} (MST ${p.mst})</option>`).join('')}</select></div>
      <div style="margin-bottom:13px"><label class="form-label">Loại hợp đồng</label>
        <select id="fType" class="form-input">
          ${['Hợp đồng thầu phụ thi công', 'Hợp đồng giao khoán', 'Hợp đồng NCC vật tư', 'Hợp đồng thuê thiết bị', 'Dịch vụ khác']
            .map((t) => `<option ${t === c.contract_type ? 'selected' : ''}>${t}</option>`).join('')}
        </select></div>
      <div style="margin-bottom:13px"><label class="form-label">Giá trị hợp đồng (₫)</label>
        <input type="number" id="fValue" class="form-input" value="${c.value}"></div>
      <div style="margin-bottom:13px"><label class="form-label">Chia theo mã ngân sách</label>
        <select id="fBudgetCode" class="form-input">${(categories || []).map((cat) => `<option value="${cat.code}" ${cat.code === currentBudgetCode ? 'selected' : ''}>${cat.code} — ${cat.name}</option>`).join('')}</select></div>
      <div style="margin-bottom:13px"><label class="form-label">Mẫu hồ sơ (luồng duyệt)</label>
        <select id="fTemplate" class="form-input">${(templates || []).map((t) => `<option value="${t.id}" ${t.id === c.template_id ? 'selected' : ''}>${t.name}</option>`).join('')}</select></div>
      <div style="margin-bottom:13px"><label class="form-label">Tờ trình chủ trương làm căn cứ (không bắt buộc)</label>
        <select id="fToTrinh" class="form-input"><option value="">— Chưa gắn —</option>${(toTrinhList || []).map((t) => `<option value="${t.id}" ${t.id === c.to_trinh_id ? 'selected' : ''}>${t.doc_number} — ${t.title}</option>`).join('')}</select></div>
    </div>
    <div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">💾 Lưu thay đổi</button></div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => openDetail(c.id, user, onClose));

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const project_id = modal.querySelector('#fProject').value;
    const partner_id = modal.querySelector('#fPartner').value;
    const contract_type = modal.querySelector('#fType').value;
    const value = Number(modal.querySelector('#fValue').value);
    const budget_code = modal.querySelector('#fBudgetCode').value;
    const template_id = modal.querySelector('#fTemplate').value;
    const to_trinh_id = modal.querySelector('#fToTrinh').value || null;

    if (!project_id || !partner_id || !value || !budget_code) return toast('Điền đủ thông tin bắt buộc', 'error');

    loading(true);
    const { error } = await supabase
      .from('contracts')
      .update({ project_id, partner_id, contract_type, value, template_id: template_id || null, to_trinh_id })
      .eq('id', c.id);
    if (error) return toast('Lỗi lưu: ' + error.message, 'error');

    await supabase.from('contract_budget_lines').delete().eq('contract_id', c.id);
    await supabase.from('contract_budget_lines').insert({ contract_id: c.id, budget_code, value });

    toast('Đã lưu thay đổi', 'success');
    openDetail(c.id, user, onClose);
  });
}

async function openCreateModal(user, onClose) {
  const modal = ensureModal();
  const { data: projects } = await supabase.from('projects').select('id, code, name').order('code');
  const { data: partners } = await supabase.from('partners').select('id, name, mst, abbr').order('name');
  const { data: categories } = await supabase.from('budget_categories').select('code, name').order('code');
  const templates = await resolveDefaultTemplates(user.id, 'contract');
  const { data: toTrinhList } = await supabase.from('to_trinh_chu_truong').select('id, doc_number, title').order('doc_number');

  const box = modal.querySelector('.panel-box') || document.createElement('div');
  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Trình hợp đồng mới</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="margin-bottom:13px"><label class="form-label">Dự án</label>
        <select id="fProject" class="form-input">${(projects || []).map((p) => `<option value="${p.id}">${p.code} — ${p.name}</option>`).join('')}</select></div>
      <div style="margin-bottom:13px"><label class="form-label">Đối tác (NTP/NCC)</label>
        <select id="fPartner" class="form-input">${(partners || []).map((p) => `<option value="${p.id}">${p.name} (MST ${p.mst})</option>`).join('')}</select>
        <div style="font-size:11.5px;color:var(--gray4);margin-top:4px">Chưa có đối tác? Vào tab Đối tác để khai báo trước, hệ thống tự chống trùng theo MST.</div></div>
      <div style="margin-bottom:13px"><label class="form-label">Loại hợp đồng</label>
        <select id="fType" class="form-input">
          <option>Hợp đồng thầu phụ thi công</option>
          <option>Hợp đồng giao khoán</option>
          <option>Hợp đồng NCC vật tư</option>
          <option>Hợp đồng thuê thiết bị</option>
          <option>Dịch vụ khác</option>
        </select></div>
      <div style="margin-bottom:13px"><label class="form-label">Giá trị hợp đồng (₫)</label>
        <input type="number" id="fValue" class="form-input" placeholder="VD: 2800000000"></div>
      <div style="margin-bottom:13px"><label class="form-label">Chia theo mã ngân sách</label>
        <select id="fBudgetCode" class="form-input">${(categories || []).map((c) => `<option value="${c.code}">${c.code} — ${c.name}</option>`).join('')}</select>
        <div style="font-size:11px;color:var(--gray4);margin-top:4px">Bản đầu: chia 100% giá trị hợp đồng vào 1 mã — chia nhiều mã sẽ làm ở bản sau.</div></div>
      <div style="margin-bottom:13px"><label class="form-label">Mẫu hồ sơ (luồng duyệt)</label>
        <select id="fTemplate" class="form-input">${(templates || []).map((t) => `<option value="${t.id}">${t.name}</option>`).join('')}</select>
        <div style="font-size:11px;color:var(--gray4);margin-top:4px">${templates.length <= 1 ? 'Tự nhận diện đúng mẫu theo phòng ban/vai trò của bạn.' : 'Đã lọc sẵn các mẫu phù hợp với bạn — không hiện mẫu của phòng ban khác.'}</div></div>
      <div style="margin-bottom:13px"><label class="form-label">Tờ trình chủ trương làm căn cứ (không bắt buộc)</label>
        <select id="fToTrinh" class="form-input"><option value="">— Chưa gắn —</option>${(toTrinhList || []).map((t) => `<option value="${t.id}">${t.doc_number} — ${t.title}</option>`).join('')}</select>
        <div style="font-size:11px;color:var(--gray4);margin-top:4px">Không có trong danh sách? Vào tab Tờ trình chủ trương tạo trước — hợp đồng vẫn trình được nếu chưa gắn, chỉ hiện cảnh báo nhẹ.</div></div>
    </div>
    <div class="panel-footer">
      <button class="btn btn-secondary" id="btnSaveDraft">💾 Lưu nháp</button>
      <button class="btn btn-primary" id="btnSubmitNew">Trình duyệt</button>
    </div>
  </div>`;
  showModal(modal, onClose);

  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  async function doSave(submitAfter) {
    const project_id = modal.querySelector('#fProject').value;
    const partner_id = modal.querySelector('#fPartner').value;
    const contract_type = modal.querySelector('#fType').value;
    const value = Number(modal.querySelector('#fValue').value);
    const budget_code = modal.querySelector('#fBudgetCode').value;
    const template_id = modal.querySelector('#fTemplate').value;
    const to_trinh_id = modal.querySelector('#fToTrinh').value || null;

    if (!project_id || !partner_id || !value || !budget_code) {
      return toast('Điền đủ thông tin bắt buộc trước khi lưu', 'error');
    }
    loading(true);

    const { data: newContract, error } = await supabase
      .from('contracts')
      .insert({ project_id, partner_id, contract_type, value, template_id: template_id || null, to_trinh_id, created_by: user.id, status: 'draft' })
      .select('id')
      .single();
    if (error) return toast('Lỗi tạo hợp đồng: ' + error.message, 'error');

    await supabase.from('contract_budget_lines').insert({ contract_id: newContract.id, budget_code, value });

    if (submitAfter) {
      const { error: subErr } = await supabase.rpc('fn_submit_document', { p_doc_type: 'contract', p_doc_id: newContract.id });
      if (subErr) return toast('Đã lưu nháp, nhưng trình lỗi: ' + subErr.message, 'error');
      toast('Đã trình hồ sơ', 'success');
      closeModal(modal, onClose);
    } else {
      toast('Đã lưu nháp — mở lại hồ sơ để đính kèm file', 'success');
      closeModal(modal, () => {});
      openDetail(newContract.id, user, onClose);
    }
  }

  modal.querySelector('#btnSaveDraft').addEventListener('click', () => doSave(false));
  modal.querySelector('#btnSubmitNew').addEventListener('click', () => doSave(true));
}

// ---- tiện ích modal dùng chung trong module này ----
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
  modal.onclick = (e) => {
    if (e.target === modal) closeModal(modal, onClose);
  };
}
function closeModal(modal, onClose) {
  modal.classList.remove('show');
  if (onClose) onClose();
}
