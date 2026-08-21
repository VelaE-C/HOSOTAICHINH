// ============================================================
// totrinh.js — Tờ trình phê duyệt chủ trương
// Luôn có TRƯỚC hợp đồng — khởi tạo không cần chọn hợp đồng nào.
// Quan hệ 1-nhiều được ghi nhận NGƯỢC từ phía hợp đồng (contracts.to_trinh_id).
// ============================================================
import { supabase } from '../core/config.js';
import { toast, loading, statusBadge } from '../core/utils.js';
import { loadApprovalState, railHtml, timelineHtml, actionFooterHtml, wireActions } from '../core/approvalUI.js';

let VIEW_PROJECT = 'ALL';

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải…</div>`;

  const { data: projects } = await supabase.from('projects').select('id, code, name').order('code');
  let q = supabase
    .from('to_trinh_chu_truong')
    .select('id, doc_number, title, status, current_step, project_id, created_at')
    .order('created_at', { ascending: false });
  if (VIEW_PROJECT !== 'ALL') q = q.eq('project_id', VIEW_PROJECT);
  const { data: rows, error } = await q;

  if (error) {
    container.innerHTML = `<div class="empty-note">⚠️ Lỗi tải dữ liệu: ${error.message}</div>`;
    return;
  }

  const sorted = [...(rows || [])].sort((a, b) => {
    const ad = a.status === 'active' ? 1 : 0;
    const bd = b.status === 'active' ? 1 : 0;
    if (ad !== bd) return ad - bd;
    return new Date(b.created_at) - new Date(a.created_at);
  });

  // Đếm số hợp đồng đã chọn từng tờ trình làm căn cứ, hiện luôn trong bảng cho tiện nhìn
  const { data: linkCounts } = await supabase.from('contracts').select('to_trinh_id').not('to_trinh_id', 'is', null);
  const countMap = {};
  (linkCounts || []).forEach((c) => (countMap[c.to_trinh_id] = (countMap[c.to_trinh_id] || 0) + 1));

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;margin-bottom:12px;gap:10px;flex-wrap:wrap">
      <select class="btn btn-secondary" id="projFilter">
        <option value="ALL" ${VIEW_PROJECT === 'ALL' ? 'selected' : ''}>Tất cả dự án</option>
        ${(projects || []).map((p) => `<option value="${p.id}" ${VIEW_PROJECT === p.id ? 'selected' : ''}>${p.code} — ${p.name}</option>`).join('')}
      </select>
      <button class="btn btn-primary" id="btnNew">+ Trình tờ trình chủ trương</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden"><table><thead><tr><th>Số hồ sơ</th><th>Tiêu đề</th><th>Hợp đồng liên kết</th><th>Trạng thái</th></tr></thead><tbody>
    ${sorted.length ? sorted.map((t) => `<tr class="click" data-id="${t.id}"><td class="mono">${t.doc_number}</td><td>${t.title}</td>
    <td>${countMap[t.id] ? `<span class="code-chip">${countMap[t.id]} hợp đồng</span>` : '<span style="color:var(--gray4);font-size:12px">Chưa có</span>'}</td>
    <td>${statusBadge(t.status)}</td></tr>`).join('') : `<tr><td colspan="4" style="text-align:center;color:var(--gray4);padding:20px">Chưa có tờ trình nào</td></tr>`}
    </tbody></table></div>`;

  container.querySelector('#projFilter').addEventListener('change', (e) => {
    VIEW_PROJECT = e.target.value;
    render(container, user);
  });
  container.querySelector('#btnNew').addEventListener('click', () => openCreateModal(user, () => render(container, user)));
  container.querySelectorAll('[data-id]').forEach((r) => r.addEventListener('click', () => openDetail(r.dataset.id, user, () => render(container, user))));
}

async function openDetail(id, user, onClose) {
  const modal = ensureModal();
  modal.innerHTML = `<div class="panel-box"><div class="empty-note">Đang tải…</div></div>`;
  showModal(modal, onClose);

  const { data: t } = await supabase.from('to_trinh_chu_truong').select('*, projects(name)').eq('id', id).single();
  if (!t) {
    modal.querySelector('.panel-box').innerHTML = `<div class="empty-note">Không tải được hồ sơ.</div>`;
    return;
  }
  const { data: linkedContracts } = await supabase.from('contracts').select('id, doc_number, value, status').eq('to_trinh_id', id);
  const { assignments, logs } = await loadApprovalState('totrinh', id);

  const box = modal.querySelector('.panel-box');
  box.innerHTML = `
    <div class="panel-header"><div><div>${t.doc_number}</div><div class="meta">${t.projects?.name || '—'}</div></div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div class="kv">
        <div class="k">Tiêu đề</div><div class="v">${t.title}</div>
        <div class="k">Nội dung</div><div class="v" style="font-weight:400">${t.content || '—'}</div>
        <div class="k">Trạng thái</div><div class="v">${statusBadge(t.status)}</div>
        <div class="k">Hợp đồng liên kết</div><div class="v">${
          linkedContracts && linkedContracts.length
            ? linkedContracts.map((c) => `<span class="code-chip" style="margin:2px 4px 2px 0">${c.doc_number} — ${statusBadge(c.status)}</span>`).join('')
            : '<span style="color:var(--gray4);font-size:12px">Chưa có hợp đồng nào chọn tờ trình này làm căn cứ</span>'
        }</div>
      </div>
      ${t.status !== 'draft' ? `<div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Luồng phê duyệt</div>${railHtml(assignments, t.current_step)}
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5);margin-top:20px">Lịch sử</div>${timelineHtml(logs)}` : `<div class="empty-note">Hồ sơ đang ở trạng thái nháp — bấm Trình duyệt để bắt đầu luồng phê duyệt.</div>`}
    </div>
    ${actionFooterHtml(t, 'totrinh', user, assignments)}
  `;
  box.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));
  wireActions(box, 'totrinh', id, t.current_step, assignments, () => closeModal(modal, onClose));
}

async function openCreateModal(user, onClose) {
  const modal = ensureModal();
  const { data: projects } = await supabase.from('projects').select('id, code, name').order('code');
  const { data: templates } = await supabase.from('document_templates').select('id, name').eq('doc_type', 'totrinh');

  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Trình tờ trình phê duyệt chủ trương</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="font-size:12px;background:var(--lblue);color:#1D4ED8;padding:9px 12px;border-radius:7px;margin-bottom:14px">ℹ️ Chưa cần chọn hợp đồng nào — tờ trình có trước, các hợp đồng sau này sẽ tự chọn tờ trình này làm căn cứ khi tạo.</div>
      <div style="margin-bottom:13px"><label class="form-label">Dự án</label>
        <select id="fProject" class="form-input">${(projects || []).map((p) => `<option value="${p.id}">${p.code} — ${p.name}</option>`).join('')}</select></div>
      <div style="margin-bottom:13px"><label class="form-label">Tiêu đề tờ trình</label>
        <input type="text" id="fTitle" class="form-input" placeholder="VD: Chủ trương phê duyệt giá bê tông toàn dự án"></div>
      <div style="margin-bottom:13px"><label class="form-label">Nội dung / phạm vi áp dụng</label>
        <textarea id="fContent" class="form-input" rows="4" placeholder="Mô tả ngắn gọn nội dung, phạm vi áp dụng của tờ trình"></textarea></div>
      <div style="margin-bottom:13px"><label class="form-label">Mẫu hồ sơ (luồng duyệt)</label>
        <select id="fTemplate" class="form-input">${(templates || []).map((t) => `<option value="${t.id}">${t.name}</option>`).join('')}</select></div>
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
    const title = modal.querySelector('#fTitle').value.trim();
    const content = modal.querySelector('#fContent').value.trim();
    const template_id = modal.querySelector('#fTemplate').value;

    if (!project_id || !title) return toast('Điền đủ Dự án và Tiêu đề trước khi lưu', 'error');
    loading(true);

    const { data: newDoc, error } = await supabase
      .from('to_trinh_chu_truong')
      .insert({ project_id, title, content, template_id: template_id || null, created_by: user.id, status: 'draft' })
      .select('id')
      .single();
    if (error) return toast('Lỗi tạo tờ trình: ' + error.message, 'error');

    if (submitAfter) {
      const { error: subErr } = await supabase.rpc('fn_submit_document', { p_doc_type: 'totrinh', p_doc_id: newDoc.id });
      if (subErr) return toast('Đã lưu nháp, nhưng trình lỗi: ' + subErr.message, 'error');
      toast('Đã trình hồ sơ', 'success');
    } else {
      toast('Đã lưu nháp', 'success');
    }
    closeModal(modal, onClose);
  }

  modal.querySelector('#btnSaveDraft').addEventListener('click', () => doSave(false));
  modal.querySelector('#btnSubmitNew').addEventListener('click', () => doSave(true));
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
