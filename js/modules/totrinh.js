// ============================================================
// totrinh.js — Tờ trình phê duyệt chủ trương
// Luôn có TRƯỚC hợp đồng — khởi tạo không cần chọn hợp đồng nào.
// Quan hệ 1-nhiều được ghi nhận NGƯỢC từ phía hợp đồng (contracts.to_trinh_id).
// ============================================================
import { supabase } from '../core/config.js';
import { toast, loading, statusBadge, pushModalHistory, popModalHistory, normalizeSearchText, paginationHtml, wirePagination, PAGE_SIZE, IS_MOBILE } from '../core/utils.js';
import { loadApprovalState, railHtml, timelineHtml, actionFooterHtml, wireActions, resolveDefaultTemplates, loadStepPreview } from '../core/approvalUI.js';
import { renderAttachments, renderFilePicker, uploadStagedFiles } from '../core/attachments.js';

let VIEW_PROJECT = 'ALL';
let VIEW_PAGE = 1;

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải…</div>`;

  const [{ data: projects }, { data: rows, error }, { data: linkCounts }] = await Promise.all([
    supabase.from('projects').select('id, code, name').order('code'),
    (VIEW_PROJECT !== 'ALL'
      ? supabase.from('to_trinh_chu_truong').select('id, doc_number, title, status, current_step, project_id, created_at, projects(name, code)').eq('project_id', VIEW_PROJECT)
      : supabase.from('to_trinh_chu_truong').select('id, doc_number, title, status, current_step, project_id, created_at, projects(name, code)')
    ).neq('status', 'cancelled').order('created_at', { ascending: false }),
    supabase.from('contracts').select('to_trinh_id').not('to_trinh_id', 'is', null),
  ]);

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
  const countMap = {};
  (linkCounts || []).forEach((c) => (countMap[c.to_trinh_id] = (countMap[c.to_trinh_id] || 0) + 1));

  container.innerHTML = `
    <div style="display:flex;${IS_MOBILE ? 'flex-direction:column;align-items:stretch' : 'justify-content:space-between;flex-wrap:wrap'};margin-bottom:12px;gap:10px">
      <div style="display:flex;gap:8px;${IS_MOBILE ? 'flex-direction:column' : 'flex-wrap:wrap'}">
        <select class="btn btn-secondary" id="projFilter" style="${IS_MOBILE ? 'width:100%;max-width:100%;box-sizing:border-box' : ''}">
          <option value="ALL" ${VIEW_PROJECT === 'ALL' ? 'selected' : ''}>Tất cả dự án</option>
          ${(projects || []).map((p) => `<option value="${p.id}" ${VIEW_PROJECT === p.id ? 'selected' : ''}>${p.code} — ${p.name}</option>`).join('')}
        </select>
        <input type="text" class="form-input" id="titleFilter" placeholder="🔎 Lọc theo tiêu đề (tên NCC/nội dung)..." style="${IS_MOBILE ? 'width:100%;max-width:100%;box-sizing:border-box' : 'min-width:260px'}">
      </div>
      <button class="btn btn-primary" id="btnNew" style="${IS_MOBILE ? 'width:100%;max-width:100%;box-sizing:border-box' : ''}">+ Trình tờ trình chủ trương</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      <div style="overflow-x:auto"><table><thead><tr>${IS_MOBILE ? '<th>Dự án</th><th>Tiêu đề</th>' : '<th>Dự án</th><th>Tiêu đề</th><th>Hợp đồng liên kết</th><th>Trạng thái</th>'}</tr></thead><tbody id="totrinhTbody"></tbody></table></div>
      <div id="totrinhPagination"></div>
    </div>`;

  let currentList = sorted;

  function draw() {
    const totalPages = Math.max(1, Math.ceil(currentList.length / PAGE_SIZE));
    VIEW_PAGE = Math.min(Math.max(1, VIEW_PAGE), totalPages);
    const pageItems = currentList.slice((VIEW_PAGE - 1) * PAGE_SIZE, VIEW_PAGE * PAGE_SIZE);
    container.querySelector('#totrinhTbody').innerHTML = renderTotrinhRows(pageItems, countMap);
    container.querySelector('#totrinhPagination').innerHTML = paginationHtml(VIEW_PAGE, currentList.length);
    wirePagination(container.querySelector('#totrinhPagination'), VIEW_PAGE, currentList.length, (p) => {
      VIEW_PAGE = p;
      draw();
    });
    container.querySelectorAll('[data-id]').forEach((r) => r.addEventListener('click', () => openDetail(r.dataset.id, user, () => render(container, user))));
  }

  container.querySelector('#titleFilter').addEventListener('input', (e) => {
    const q = normalizeSearchText(e.target.value);
    currentList = q ? sorted.filter((t) => normalizeSearchText(t.title || '').includes(q)) : sorted;
    VIEW_PAGE = 1;
    draw();
  });

  container.querySelector('#projFilter').addEventListener('change', (e) => {
    VIEW_PROJECT = e.target.value;
    VIEW_PAGE = 1;
    render(container, user);
  });
  container.querySelector('#btnNew').addEventListener('click', () => openCreateModal(user, () => render(container, user)));
  draw();
}

function renderTotrinhRows(list, countMap) {
  if (!list.length) return `<tr><td colspan="${IS_MOBILE ? 2 : 4}" style="text-align:center;color:var(--gray4);padding:20px">Không có tờ trình nào — kiểm tra lại bộ lọc Dự án/Tiêu đề nếu đang lọc</td></tr>`;
  return list
    .map((t) =>
      IS_MOBILE
        ? `<tr class="click" data-id="${t.id}"><td>${t.projects?.code || '—'}</td><td>${t.title}</td></tr>`
        : `<tr class="click" data-id="${t.id}"><td>${t.projects?.code || '—'}</td><td>${t.title}</td>
    <td>${countMap[t.id] ? `<span class="code-chip">${countMap[t.id]} hợp đồng</span>` : '<span style="color:var(--gray4);font-size:12px">Chưa có</span>'}</td>
    <td>${statusBadge(t.status)}</td></tr>`,
    )
    .join('');
}

// Xuất tờ cover để kẹp hồ sơ cứng — giống hệt cách làm ở Hợp đồng, chỉ đổi nội dung
async function openPrintCoverSheet(t, assignments, logs) {
  const { data: files } = await supabase.from('attachments').select('file_name').eq('owner_type', 'totrinh').eq('owner_id', t.id);

  const submitLog = logs.find((l) => l.action === 'submit');
  const commentLogs = logs.filter((l) => l.comment);
  const vnDate = (d) => (d ? new Date(d).toLocaleDateString('vi-VN') : '—');

  const workflowRows = assignments
    .map((a) => ({
      step: a.step_no,
      name: a.users?.full_name || '—',
      jobTitle: a.users?.job_title || '',
      status: a.status === 'approved' ? 'Duyệt' : a.status === 'rejected' ? 'Từ chối' : 'Đang chờ',
      doneDate: vnDate(a.acted_at),
    }))
    .sort((x, y) => x.step - y.step);

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${t.doc_number}</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:12.5px;padding:24px;color:#111}
      table{width:100%;border-collapse:collapse;margin-bottom:10px}
      td,th{border:1px solid #333;padding:6px 9px;text-align:left;vertical-align:top}
      th{background:#f0ece3}
      .title{font-size:16px;font-weight:700;text-align:center;padding:10px}
      .label{font-weight:600;width:190px;background:#f7f5f0}
      .no-print{margin-bottom:14px}
      .logo{height:42px;margin-bottom:12px;display:block}
      @media print{.no-print{display:none}}
    </style></head>
    <body>
      <div class="no-print"><button onclick="window.print()" style="padding:8px 16px;font-size:13px">🖨️ In / Lưu thành PDF</button></div>
      <img class="logo" src="https://raw.githubusercontent.com/VelaE-C/HOSOTAICHINH/refs/heads/main/LOGO%20DUNG.JPEG.png" alt="VELA">
      <table>
        <tr><td colspan="2" class="title">WORKFLOW TỜ TRÌNH PHÊ DUYỆT CHỦ TRƯƠNG</td></tr>
        <tr><td class="label">Số tờ trình</td><td>${t.doc_number}</td></tr>
        <tr><td class="label">Ngày lập</td><td>${vnDate(t.signed_date)}</td></tr>
        <tr><td class="label">Quy trình duyệt</td><td>${t.document_templates?.name || '—'}</td></tr>
        <tr><td class="label">Dự án</td><td>${t.projects?.name || '—'}</td></tr>
        <tr><td class="label">Tiêu đề</td><td>${t.title}</td></tr>
        <tr><td class="label">Nội dung</td><td>${t.content || '—'}</td></tr>
        <tr><td class="label">Ngày gửi</td><td>${submitLog ? vnDate(submitLog.created_at) : '—'}</td></tr>
        <tr><td class="label">Người lập / Người gửi duyệt</td><td>${t.users?.full_name || '—'}</td></tr>
      </table>

      <table><tr><th colspan="2">Tài liệu đính kèm</th></tr>
        ${(files || []).length ? files.map((f, i) => `<tr><td style="width:40px">${i + 1}</td><td>${f.file_name}</td></tr>`).join('') : '<tr><td colspan="2" style="color:#888">Không có file đính kèm</td></tr>'}
      </table>

      <table><tr><th colspan="2">Ý kiến</th></tr>
        ${commentLogs.length ? commentLogs.map((l) => `<tr><td style="width:170px;font-weight:600">${l.users?.full_name || '—'}</td><td>${l.comment}</td></tr>`).join('') : '<tr><td colspan="2" style="color:#888">Không có ý kiến bổ sung</td></tr>'}
      </table>

      <table>
        <tr><th>Thứ tự duyệt</th><th>Người thực hiện</th><th>Chức danh</th><th>Trạng thái</th><th>Ngày hoàn thành</th></tr>
        ${workflowRows.map((r) => `<tr><td>${r.step}</td><td>${r.name}</td><td>${r.jobTitle}</td><td>${r.status}</td><td>${r.doneDate}</td></tr>`).join('')}
        <tr><td colspan="4" style="text-align:right;font-weight:700">Hoàn thành duyệt</td><td>${vnDate(t.completed_at)}</td></tr>
      </table>
    </body></html>`;

  const w = window.open('', '_blank');
  if (!w) {
    toast('Trình duyệt đang chặn cửa sổ bật lên — cho phép popup rồi thử lại.', 'error');
    return;
  }
  w.document.write(html);
  w.document.close();
  setTimeout(() => w.print(), 400);
}

export async function openDetail(id, user, onClose) {
  const modal = ensureModal();
  modal.innerHTML = `<div class="panel-box"><div class="empty-note">Đang tải…</div></div>`;
  showModal(modal, onClose, `totrinh/${id}`);

  const { data: t } = await supabase.from('to_trinh_chu_truong').select('*, projects(name), document_templates(name), users!created_by(full_name)').eq('id', id).single();
  if (!t) {
    modal.querySelector('.panel-box').innerHTML = `<div class="empty-note">Không tải được hồ sơ.</div>`;
    return;
  }
  const { data: linkedContracts } = await supabase.from('contracts').select('id, doc_number, value, status').eq('to_trinh_id', id);
  const { assignments, logs } = await loadApprovalState('totrinh', id);
  const preview = t.status === 'pending' ? await loadStepPreview(t.project_id, t.template_id, t.current_step) : {};

  const canEditNow = t.created_by === user.id && ['draft', 'rejected'].includes(t.status);
  const canExportPdf = t.current_step >= 3 || t.status === 'active';
  const isAdmin = (user.roles || []).includes('Admin');
  const canCancel = isAdmin && ['draft', 'rejected'].includes(t.status);
  const box = modal.querySelector('.panel-box');
  box.innerHTML = `
    <div class="panel-header"><div><div>${t.doc_number}</div><div class="meta">${t.projects?.name || '—'}</div></div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        ${canEditNow ? `<button class="btn btn-sm btn-secondary" id="btnEdit">✏️ Sửa</button>` : ''}
        ${canExportPdf ? `<button class="btn btn-sm btn-secondary" id="btnExportPdf">🖨️ Xuất PDF (tờ cover)</button>` : ''}
        ${canCancel ? `<button class="btn btn-sm btn-danger" id="btnCancel">🗑️ Hủy hồ sơ</button>` : ''}
        <button class="panel-close" id="pClose">✕</button>
      </div></div>
    <div class="panel-body">
      <div class="kv">
        <div class="k">Tiêu đề</div><div class="v">${t.title}</div>
        <div class="k">Nội dung</div><div class="v" style="font-weight:400">${t.content || '—'}</div>
        <div class="k">Ngày ký hồ sơ</div><div class="v">${t.signed_date ? new Date(t.signed_date).toLocaleDateString('vi-VN') : '<span style="color:var(--gray4)">Chưa ghi</span>'}</div>
        ${t.completed_at ? `<div class="k">Ngày hoàn thành</div><div class="v">${new Date(t.completed_at).toLocaleDateString('vi-VN')}</div>` : ''}
        <div class="k">Trạng thái</div><div class="v">${statusBadge(t.status)}</div>
        <div class="k">Hợp đồng liên kết</div><div class="v">${
          linkedContracts && linkedContracts.length
            ? linkedContracts.map((c) => `<span class="code-chip" style="margin:2px 4px 2px 0">${c.doc_number} — ${statusBadge(c.status)}</span>`).join('')
            : '<span style="color:var(--gray4);font-size:12px">Chưa có hợp đồng nào chọn tờ trình này làm căn cứ</span>'
        }</div>
      </div>
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Hồ sơ đính kèm</div>
      <div class="card" id="attachArea"></div>
      ${t.status !== 'draft' ? `<div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Luồng phê duyệt</div>${railHtml(assignments, t.current_step, preview)}
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5);margin-top:20px">Lịch sử</div>${timelineHtml(logs)}` : `<div class="empty-note">Hồ sơ đang ở trạng thái nháp — bấm Trình duyệt để bắt đầu luồng phê duyệt.</div>`}
    </div>
    ${actionFooterHtml(t, 'totrinh', user, assignments, (user.roles || []).includes('Admin'))}
  `;
  box.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));
  box.querySelector('#btnEdit')?.addEventListener('click', () => openEditModal(t, user, onClose));
  box.querySelector('#btnExportPdf')?.addEventListener('click', () => openPrintCoverSheet(t, assignments, logs));
  box.querySelector('#btnCancel')?.addEventListener('click', async () => {
    if (!confirm(`Hủy hồ sơ "${t.doc_number}"?\n\nHồ sơ sẽ chuyển sang trạng thái "Đã hủy", ẩn khỏi danh sách chính — dữ liệu vẫn được giữ nguyên, không mất gì cả. Không hoàn tác được qua giao diện.`)) return;
    const reason = prompt('Lý do hủy (không bắt buộc):') || null;
    loading(true);
    const { error } = await supabase.rpc('fn_cancel_document', { p_doc_type: 'totrinh', p_doc_id: t.id, p_reason: reason });
    if (error) return toast('Lỗi: ' + error.message, 'error');
    toast('Đã hủy hồ sơ', 'success');
    closeModal(modal, onClose);
  });
  renderAttachments(box.querySelector('#attachArea'), 'totrinh', id, user.id, canEditNow);
  wireActions(box, 'totrinh', id, t.current_step, assignments, () => closeModal(modal, onClose));
}

async function openEditModal(t, user, onClose) {
  const modal = ensureModal();
  const { data: projects } = await supabase.from('projects').select('id, code, name').order('code');
  const templates = await resolveDefaultTemplates(user.id, 'totrinh');

  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Sửa tờ trình — ${t.doc_number}</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="margin-bottom:13px"><label class="form-label">Dự án</label>
        <select id="fProject" class="form-input">${(projects || []).map((p) => `<option value="${p.id}" ${p.id === t.project_id ? 'selected' : ''}>${p.code} — ${p.name}</option>`).join('')}</select></div>
      <div style="margin-bottom:13px"><label class="form-label">Tiêu đề tờ trình</label>
        <input type="text" id="fTitle" class="form-input" value="${t.title}"></div>
      <div style="margin-bottom:13px"><label class="form-label">Nội dung / phạm vi áp dụng</label>
        <textarea id="fContent" class="form-input" rows="4">${t.content || ''}</textarea></div>
      <div style="margin-bottom:13px"><label class="form-label">Ngày ký hồ sơ (không bắt buộc)</label>
        <input type="date" id="fSignedDate" class="form-input" value="${t.signed_date || ''}"></div>
      <div style="margin-bottom:13px"><label class="form-label">Mẫu hồ sơ (luồng duyệt)</label>
        <select id="fTemplate" class="form-input">${(templates || []).map((tp) => `<option value="${tp.id}" ${tp.id === t.template_id ? 'selected' : ''}>${tp.name}</option>`).join('')}</select></div>
    </div>
    <div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">💾 Lưu thay đổi</button></div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => openDetail(t.id, user, onClose));

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const project_id = modal.querySelector('#fProject').value;
    const title = modal.querySelector('#fTitle').value.trim();
    const content = modal.querySelector('#fContent').value.trim();
    const signed_date = modal.querySelector('#fSignedDate').value || null;
    const template_id = modal.querySelector('#fTemplate').value;

    if (!project_id || !title) return toast('Điền đủ Dự án và Tiêu đề', 'error');

    loading(true);
    const { error } = await supabase.from('to_trinh_chu_truong').update({ project_id, title, content, signed_date, template_id: template_id || null }).eq('id', t.id);
    if (error) return toast('Lỗi lưu: ' + error.message, 'error');

    toast('Đã lưu thay đổi', 'success');
    openDetail(t.id, user, onClose);
  });
}

async function openCreateModal(user, onClose) {
  const modal = ensureModal();
  const { data: projects } = await supabase.from('projects').select('id, code, name').order('code');
  const templates = await resolveDefaultTemplates(user.id, 'totrinh');

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
      <div style="margin-bottom:13px"><label class="form-label">Ngày ký hồ sơ (không bắt buộc)</label>
        <input type="date" id="fSignedDate" class="form-input"></div>
      <div style="margin-bottom:13px"><label class="form-label">Mẫu hồ sơ (luồng duyệt)</label>
        <select id="fTemplate" class="form-input">${(templates || []).map((t) => `<option value="${t.id}">${t.name}</option>`).join('')}</select>
        <div style="font-size:11px;color:var(--gray4);margin-top:4px">${templates.length <= 1 ? 'Tự nhận diện đúng mẫu theo phòng ban/vai trò của bạn.' : 'Đã lọc sẵn các mẫu phù hợp với bạn.'}</div></div>
      <label class="form-label">Hồ sơ đính kèm</label>
      <div class="card" id="filePickerWrap" style="padding:12px 14px;margin-bottom:13px"></div>
    </div>
    <div class="panel-footer">
      <button class="btn btn-secondary" id="btnSaveDraft">💾 Lưu nháp</button>
      <button class="btn btn-primary" id="btnSubmitNew">Trình duyệt</button>
    </div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));
  const filePicker = renderFilePicker(modal.querySelector('#filePickerWrap'));

  async function doSave(submitAfter) {
    const project_id = modal.querySelector('#fProject').value;
    const title = modal.querySelector('#fTitle').value.trim();
    const content = modal.querySelector('#fContent').value.trim();
    const signed_date = modal.querySelector('#fSignedDate').value || null;
    const template_id = modal.querySelector('#fTemplate').value;

    if (!project_id || !title) return toast('Điền đủ Dự án và Tiêu đề trước khi lưu', 'error');
    loading(true);

    const { data: newDocId, error } = await supabase.rpc('fn_create_totrinh', {
      p_project_id: project_id,
      p_title: title,
      p_content: content,
      p_signed_date: signed_date,
      p_template_id: template_id || null,
    });
    if (error) return toast('Lỗi tạo tờ trình: ' + error.message, 'error');
    const newDoc = { id: newDocId };

    await uploadStagedFiles(filePicker.getFiles(), 'totrinh', newDoc.id, user.id);

    if (submitAfter) {
      const { error: subErr } = await supabase.rpc('fn_submit_document', { p_doc_type: 'totrinh', p_doc_id: newDoc.id });
      if (subErr) return toast('Đã lưu nháp, nhưng trình lỗi: ' + subErr.message, 'error');
      toast('Đã trình hồ sơ', 'success');
      closeModal(modal, onClose);
    } else {
      toast('Đã lưu nháp — mở lại hồ sơ để đính kèm file', 'success');
      closeModal(modal, () => {});
      openDetail(newDoc.id, user, onClose);
    }
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
function showModal(modal, onClose, hashOverride) {
  modal.classList.add('show');
  modal.scrollTop = 0; // đưa về đúng đầu trang — phòng trình duyệt di động giữ vị trí cuộn cũ
  pushModalHistory(hashOverride);
  // Cố tình KHÔNG đóng khi bấm ra ngoài — tránh mất dữ liệu đang nhập nếu lỡ tay bấm trượt.
  // Chỉ đóng bằng nút X (hoặc nút Hủy/nút quay lại chi tiết).
}
function closeModal(modal, onClose) {
  modal.classList.remove('show');
  popModalHistory();
  if (onClose) onClose();
}
