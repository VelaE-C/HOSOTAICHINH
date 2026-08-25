// ============================================================
// hopdong.js — Module Hợp đồng đầu vào (NTP/NCC)
// ============================================================
import { supabase } from '../core/config.js';
import { fmt, toast, loading, statusBadge, wireMoneyInputs, parseMoneyInput, formatMoneyInput, pushModalHistory, popModalHistory } from '../core/utils.js';
import { loadApprovalState, railHtml, timelineHtml, actionFooterHtml, wireActions, resolveDefaultTemplates, budgetLineRowHtml, wireBudgetLines, readBudgetLines } from '../core/approvalUI.js';
import { renderAttachments, renderFilePicker, uploadStagedFiles } from '../core/attachments.js';

let VIEW_PROJECT = 'ALL';

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải…</div>`;

  const [{ data: projects }, { data: contracts, error }] = await Promise.all([
    supabase.from('projects').select('id, code, name').order('code'),
    (VIEW_PROJECT !== 'ALL'
      ? supabase.from('contracts').select('id, doc_number, contract_type, value, status, current_step, to_trinh_id, project_id, created_at, partners(name)').eq('project_id', VIEW_PROJECT)
      : supabase.from('contracts').select('id, doc_number, contract_type, value, status, current_step, to_trinh_id, project_id, created_at, partners(name)')
    ).order('created_at', { ascending: false }),
  ]);

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

// Xuất tờ cover để kẹp hồ sơ cứng — dùng chức năng In của trình duyệt (không dùng
// thư viện tạo PDF riêng, vì các thư viện đó thường không hiện đúng dấu tiếng Việt
// nếu không nhúng font riêng rất phức tạp). Người dùng chọn "Lưu thành PDF" ở hộp
// thoại in — chắc chắn hiện đúng tiếng Việt 100%.
async function openPrintCoverSheet(c, assignments, logs) {
  const { data: files } = await supabase.from('attachments').select('file_name').eq('owner_type', 'contract').eq('owner_id', c.id);

  const submitLog = logs.find((l) => l.action === 'submit');
  const commentLogs = logs.filter((l) => l.comment);
  const vnDate = (d) => (d ? new Date(d).toLocaleDateString('vi-VN') : '—');

  const workflowRows = assignments
    .map((a) => ({
      step: a.step_no,
      name: a.users?.full_name || '—',
      status: a.status === 'approved' ? 'Duyệt' : a.status === 'rejected' ? 'Từ chối' : 'Đang chờ',
      doneDate: vnDate(a.acted_at),
    }))
    .sort((x, y) => x.step - y.step);

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${c.doc_number}</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:12.5px;padding:24px;color:#111}
      table{width:100%;border-collapse:collapse;margin-bottom:10px}
      td,th{border:1px solid #333;padding:6px 9px;text-align:left;vertical-align:top}
      th{background:#f0ece3}
      .title{font-size:16px;font-weight:700;text-align:center;padding:10px}
      .label{font-weight:600;width:190px;background:#f7f5f0}
      .no-print{margin-bottom:14px}
      @media print{.no-print{display:none}}
    </style></head>
    <body>
      <div class="no-print"><button onclick="window.print()" style="padding:8px 16px;font-size:13px">🖨️ In / Lưu thành PDF</button></div>
      <table>
        <tr><td colspan="2" class="title">WORKFLOW HỢP ĐỒNG, PHỤ LỤC HỢP ĐỒNG</td></tr>
        <tr><td class="label">Số HĐ/PLHĐ</td><td>${c.doc_number}</td></tr>
        <tr><td class="label">Ngày lập</td><td>${vnDate(c.signed_date)}</td></tr>
        <tr><td class="label">Quy trình duyệt</td><td>${c.document_templates?.name || '—'}</td></tr>
        <tr><td class="label">Đối tác</td><td>${c.partners?.name || '—'}</td></tr>
        <tr><td class="label">Gói thầu / Nội dung</td><td>${c.projects?.name || '—'}</td></tr>
        <tr><td class="label">Ngày gửi</td><td>${submitLog ? vnDate(submitLog.created_at) : '—'}</td></tr>
        <tr><td class="label">Người lập / Người gửi duyệt</td><td>${c.users?.full_name || '—'}</td></tr>
        <tr><td class="label">Giá trị HĐ/PLHĐ</td><td>${fmt(c.value)} ₫ (đã bao gồm VAT)</td></tr>
      </table>

      <table><tr><th colspan="2">Tài liệu đính kèm</th></tr>
        ${(files || []).length ? files.map((f, i) => `<tr><td style="width:40px">${i + 1}</td><td>${f.file_name}</td></tr>`).join('') : '<tr><td colspan="2" style="color:#888">Không có file đính kèm</td></tr>'}
      </table>

      <table><tr><th colspan="2">Ý kiến</th></tr>
        ${commentLogs.length ? commentLogs.map((l) => `<tr><td style="width:170px;font-weight:600">${l.users?.full_name || '—'}</td><td>${l.comment}</td></tr>`).join('') : '<tr><td colspan="2" style="color:#888">Không có ý kiến bổ sung</td></tr>'}
      </table>

      <table>
        <tr><th>Thứ tự duyệt</th><th>Người thực hiện</th><th>Trạng thái</th><th>Ngày hoàn thành</th></tr>
        ${workflowRows.map((r) => `<tr><td>${r.step}</td><td>${r.name}</td><td>${r.status}</td><td>${r.doneDate}</td></tr>`).join('')}
        <tr><td colspan="3" style="text-align:right;font-weight:700">Hoàn thành duyệt</td><td>${vnDate(c.completed_at)}</td></tr>
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
  showModal(modal, onClose, `hopdong/${id}`);

  const { data: c } = await supabase
    .from('contracts')
    .select('*, partners(name), projects(name), to_trinh_chu_truong(doc_number, title), contract_budget_lines(budget_code, value), document_templates(name), users!created_by(full_name)')
    .eq('id', id)
    .single();
  if (!c) {
    modal.querySelector('.panel-box').innerHTML = `<div class="empty-note">Không tải được hồ sơ (có thể không còn quyền xem).</div>`;
    return;
  }
  const { assignments, logs } = await loadApprovalState('contract', id);

  const canEditNow = c.created_by === user.id && ['draft', 'rejected'].includes(c.status);
  const isKscp = (user.roles || []).some((r) => ['Admin', 'QLCPHD_CV', 'QLCPHD_TP'].includes(r));
  const canExportPdf = c.current_step >= 4 || c.status === 'active'; // từ khi qua Bước 3, hoặc đã hoàn tất
  const box = modal.querySelector('.panel-box');
  box.innerHTML = `
    <div class="panel-header"><div><div>${c.doc_number}</div><div class="meta">${c.contract_type} · ${c.partners?.name || '—'}</div></div>
      <div style="display:flex;gap:6px;align-items:center">
        ${canEditNow ? `<button class="btn btn-sm btn-secondary" id="btnEdit">✏️ Sửa</button>` : ''}
        ${isKscp ? `<button class="btn btn-sm btn-secondary" id="btnEditBudgetLines">🧮 Sửa mã ngân sách</button>` : ''}
        ${canExportPdf ? `<button class="btn btn-sm btn-secondary" id="btnExportPdf">🖨️ Xuất PDF (tờ cover)</button>` : ''}
        <button class="panel-close" id="pClose">✕</button>
      </div></div>
    <div class="panel-body">
      ${c.budget_overrun_flag ? `<div class="warn-box">⚠️ <div><b>Case 2 — Cam kết đã vượt Ngân sách phân bổ.</b> Không dùng phụ lục hợp đồng cho trường hợp này — cần QLCP&HĐ ban hành phiên bản ngân sách mới.</div></div>` : ''}
      ${c.pending_addendum_flag ? `<div class="warn-box">⚠️ <div><b>Case 1 — Đang chờ bổ sung phụ lục hợp đồng</b> (bill đã vượt giá trị hợp đồng gốc).</div></div>` : ''}
      <div class="kv">
        <div class="k">Dự án</div><div class="v">${c.projects?.name || '—'}</div>
        <div class="k">Giá trị hợp đồng</div><div class="v mono" style="font-weight:700">${fmt(c.value)} ₫</div>
        <div class="k">Ngày ký hồ sơ</div><div class="v">${c.signed_date ? new Date(c.signed_date).toLocaleDateString('vi-VN') : '<span style="color:var(--gray4)">Chưa ghi</span>'}</div>
        ${c.completed_at ? `<div class="k">Ngày hoàn thành</div><div class="v">${new Date(c.completed_at).toLocaleDateString('vi-VN')}</div>` : ''}
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
  box.querySelector('#btnEditBudgetLines')?.addEventListener('click', () => openBudgetLinesEditor(c, user, onClose));
  box.querySelector('#btnExportPdf')?.addEventListener('click', () => openPrintCoverSheet(c, assignments, logs));
  const canEditAttach = canEditNow;
  renderAttachments(box.querySelector('#attachArea'), 'contract', id, user.id, canEditAttach);
  wireActions(box, 'contract', id, c.current_step, assignments, () => {
    closeModal(modal, onClose);
  });
}

async function openBudgetLinesEditor(c, user, onClose) {
  const modal = ensureModal();
  const { data: categories } = await supabase.from('budget_categories').select('code, name').order('code');
  const { data: currentLines } = await supabase.from('contract_budget_lines').select('budget_code, value').eq('contract_id', c.id);

  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Sửa mã ngân sách — ${c.doc_number}</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="font-size:12px;background:var(--lblue);color:#1D4ED8;padding:9px 12px;border-radius:7px;margin-bottom:14px">ℹ️ Chỉ sửa cách chia mã ngân sách để phục vụ đối chiếu báo cáo tài chính — không đụng tới nội dung/giá trị hợp đồng hay luồng duyệt.</div>
      <div class="card" id="budgetLinesWrap" style="padding:12px 14px">
        <div class="bl-rows">${(currentLines && currentLines.length ? currentLines : [{}]).map((l) => budgetLineRowHtml(categories || [], l.budget_code, l.value)).join('')}</div>
        <button type="button" class="btn btn-sm btn-secondary bl-add">+ Thêm dòng</button>
        <div class="bl-total" style="font-size:12px;margin-top:8px;font-weight:600"></div>
      </div>
    </div>
    <div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">💾 Lưu điều chỉnh</button></div>
  </div>`;
  showModal(modal, onClose);
  wireMoneyInputs(modal);
  modal.querySelector('#pClose').addEventListener('click', () => openDetail(c.id, user, onClose));
  wireBudgetLines(modal.querySelector('#budgetLinesWrap'), categories || [], '#__no_target__'); // không cần khớp tổng cụ thể

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const lines = readBudgetLines(modal.querySelector('#budgetLinesWrap'));
    if (!lines.length) return toast('Chọn ít nhất 1 mã ngân sách có giá trị', 'error');

    loading(true);
    await supabase.from('contract_budget_lines').delete().eq('contract_id', c.id);
    const { error } = await supabase.from('contract_budget_lines').insert(lines.map((l) => ({ contract_id: c.id, budget_code: l.budget_code, value: l.value })));
    if (error) return toast('Lỗi lưu: ' + error.message, 'error');

    await supabase.from('approval_logs').insert({ document_type: 'contract', document_id: c.id, user_id: user.id, action: 'edit_budget', comment: 'QLCP&HĐ điều chỉnh chia mã ngân sách' });

    toast('Đã lưu điều chỉnh mã ngân sách', 'success');
    openDetail(c.id, user, onClose);
  });
}

async function openEditModal(c, user, onClose) {
  const modal = ensureModal();
  const { data: projects } = await supabase.from('projects').select('id, code, name').order('code');
  const { data: partners } = await supabase.from('partners').select('id, name, mst, abbr').order('name');
  const { data: categories } = await supabase.from('budget_categories').select('code, name').order('code');
  const { data: templates } = await supabase.from('document_templates').select('id, name').eq('doc_type', 'contract');
  const { data: toTrinhList } = await supabase.from('to_trinh_chu_truong').select('id, doc_number, title').order('doc_number');
  const { data: currentLines } = await supabase.from('contract_budget_lines').select('budget_code, value').eq('contract_id', c.id);

  const initialRows = (currentLines && currentLines.length ? currentLines : [{ budget_code: categories?.[0]?.code, value: c.value }])
    .map((l) => budgetLineRowHtml(categories || [], l.budget_code, l.value)).join('');

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
      <div style="margin-bottom:13px"><label class="form-label">Giá trị hợp đồng (₫, có VAT)</label>
        <input type="text" inputmode="numeric" id="fValue" class="form-input money-input" value="${formatMoneyInput(c.value)}"></div>
      <div style="margin-bottom:13px"><label class="form-label">Ngày ký hồ sơ (ngày lập, trên bản giấy — không bắt buộc)</label>
        <input type="date" id="fSignedDate" class="form-input" value="${c.signed_date || ''}"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:13px">
        <div><label class="form-label">Tỉ lệ giữ lại bảo hành (%)</label><input type="number" id="fRetention" class="form-input" value="${c.retention_rate ?? 10}" step="0.1"></div>
        <div><label class="form-label">Thuế suất VAT (%)</label><input type="number" id="fVat" class="form-input" value="${c.vat_rate ?? 8}" step="0.1"></div>
      </div>
      <label class="form-label">Chia theo mã ngân sách (1 hợp đồng có thể chia nhiều hạng mục)</label>
      <div class="card" id="budgetLinesWrap" style="padding:12px 14px;margin-bottom:13px">
        <div class="bl-rows">${initialRows}</div>
        <button type="button" class="btn btn-sm btn-secondary bl-add">+ Thêm dòng</button>
        <div class="bl-total" style="font-size:12px;margin-top:8px;font-weight:600"></div>
      </div>
      <div style="margin-bottom:13px"><label class="form-label">Mẫu hồ sơ (luồng duyệt)</label>
        <select id="fTemplate" class="form-input">${(templates || []).map((t) => `<option value="${t.id}" ${t.id === c.template_id ? 'selected' : ''}>${t.name}</option>`).join('')}</select></div>
      <div style="margin-bottom:13px"><label class="form-label">Tờ trình chủ trương làm căn cứ (không bắt buộc)</label>
        <select id="fToTrinh" class="form-input"><option value="">— Chưa gắn —</option>${(toTrinhList || []).map((t) => `<option value="${t.id}" ${t.id === c.to_trinh_id ? 'selected' : ''}>${t.doc_number} — ${t.title}</option>`).join('')}</select></div>
    </div>
    <div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">💾 Lưu thay đổi</button></div>
  </div>`;
  showModal(modal, onClose);
  wireMoneyInputs(modal);
  modal.querySelector('#pClose').addEventListener('click', () => openDetail(c.id, user, onClose));
  wireBudgetLines(modal.querySelector('#budgetLinesWrap'), categories || [], '#fValue');

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const project_id = modal.querySelector('#fProject').value;
    const partner_id = modal.querySelector('#fPartner').value;
    const contract_type = modal.querySelector('#fType').value;
    const value = parseMoneyInput(modal.querySelector('#fValue').value);
    const signed_date = modal.querySelector('#fSignedDate').value || null;
    const retention_rate = Number(modal.querySelector('#fRetention').value);
    const vat_rate = Number(modal.querySelector('#fVat').value);
    const lines = readBudgetLines(modal.querySelector('#budgetLinesWrap'));
    const template_id = modal.querySelector('#fTemplate').value;
    const to_trinh_id = modal.querySelector('#fToTrinh').value || null;

    if (!project_id || !partner_id || !value || !lines.length) return toast('Điền đủ thông tin bắt buộc (kể cả chia mã ngân sách)', 'error');
    const sumLines = lines.reduce((s, l) => s + l.value, 0);
    if (Math.abs(sumLines - value) > 1) return toast(`Tổng chia mã ngân sách (${sumLines.toLocaleString('vi-VN')}) phải khớp đúng giá trị hợp đồng (${value.toLocaleString('vi-VN')})`, 'error');

    loading(true);
    const { error } = await supabase
      .from('contracts')
      .update({ project_id, partner_id, contract_type, value, signed_date, retention_rate, vat_rate, template_id: template_id || null, to_trinh_id })
      .eq('id', c.id);
    if (error) return toast('Lỗi lưu: ' + error.message, 'error');

    await supabase.from('contract_budget_lines').delete().eq('contract_id', c.id);
    await supabase.from('contract_budget_lines').insert(lines.map((l) => ({ contract_id: c.id, budget_code: l.budget_code, value: l.value })));

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
      <div style="margin-bottom:13px"><label class="form-label">Giá trị hợp đồng (₫, có VAT)</label>
        <input type="text" inputmode="numeric" id="fValue" class="form-input money-input" placeholder="VD: 2.800.000.000"></div>
      <div style="margin-bottom:13px"><label class="form-label">Ngày ký hồ sơ (ngày lập, trên bản giấy — không bắt buộc)</label>
        <input type="date" id="fSignedDate" class="form-input"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:13px">
        <div><label class="form-label">Tỉ lệ giữ lại bảo hành (%)</label><input type="number" id="fRetention" class="form-input" value="10" step="0.1"></div>
        <div><label class="form-label">Thuế suất VAT (%)</label><input type="number" id="fVat" class="form-input" value="8" step="0.1"></div>
      </div>
      <label class="form-label">Chia theo mã ngân sách (1 hợp đồng có thể chia nhiều hạng mục)</label>
      <div class="card" id="budgetLinesWrap" style="padding:12px 14px;margin-bottom:13px">
        <div class="bl-rows">${budgetLineRowHtml(categories || [])}</div>
        <button type="button" class="btn btn-sm btn-secondary bl-add">+ Thêm dòng</button>
        <div class="bl-total" style="font-size:12px;margin-top:8px;font-weight:600"></div>
      </div>
      <div style="margin-bottom:13px"><label class="form-label">Mẫu hồ sơ (luồng duyệt)</label>
        <select id="fTemplate" class="form-input">${(templates || []).map((t) => `<option value="${t.id}">${t.name}</option>`).join('')}</select>
        <div style="font-size:11px;color:var(--gray4);margin-top:4px">${templates.length <= 1 ? 'Tự nhận diện đúng mẫu theo phòng ban/vai trò của bạn.' : 'Đã lọc sẵn các mẫu phù hợp với bạn — không hiện mẫu của phòng ban khác.'}</div></div>
      <div style="margin-bottom:13px"><label class="form-label">Tờ trình chủ trương làm căn cứ (không bắt buộc)</label>
        <select id="fToTrinh" class="form-input"><option value="">— Chưa gắn —</option>${(toTrinhList || []).map((t) => `<option value="${t.id}">${t.doc_number} — ${t.title}</option>`).join('')}</select>
        <div style="font-size:11px;color:var(--gray4);margin-top:4px">Không có trong danh sách? Vào tab Tờ trình chủ trương tạo trước — hợp đồng vẫn trình được nếu chưa gắn, chỉ hiện cảnh báo nhẹ.</div></div>
      <label class="form-label">Hồ sơ đính kèm</label>
      <div class="card" id="filePickerWrap" style="padding:12px 14px;margin-bottom:13px"></div>
    </div>
    <div class="panel-footer">
      <button class="btn btn-secondary" id="btnSaveDraft">💾 Lưu nháp</button>
      <button class="btn btn-primary" id="btnSubmitNew">Trình duyệt</button>
    </div>
  </div>`;
  showModal(modal, onClose);
  wireMoneyInputs(modal);

  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));
  wireBudgetLines(modal.querySelector('#budgetLinesWrap'), categories || [], '#fValue');
  const filePicker = renderFilePicker(modal.querySelector('#filePickerWrap'));

  async function doSave(submitAfter) {
    const project_id = modal.querySelector('#fProject').value;
    const partner_id = modal.querySelector('#fPartner').value;
    const contract_type = modal.querySelector('#fType').value;
    const value = parseMoneyInput(modal.querySelector('#fValue').value);
    const signed_date = modal.querySelector('#fSignedDate').value || null;
    const retention_rate = Number(modal.querySelector('#fRetention').value);
    const vat_rate = Number(modal.querySelector('#fVat').value);
    const lines = readBudgetLines(modal.querySelector('#budgetLinesWrap'));
    const template_id = modal.querySelector('#fTemplate').value;
    const to_trinh_id = modal.querySelector('#fToTrinh').value || null;

    if (!project_id || !partner_id || !value || !lines.length) {
      return toast('Điền đủ thông tin bắt buộc trước khi lưu (kể cả chia mã ngân sách)', 'error');
    }
    const sumLines = lines.reduce((s, l) => s + l.value, 0);
    if (Math.abs(sumLines - value) > 1) return toast(`Tổng chia mã ngân sách (${sumLines.toLocaleString('vi-VN')}) phải khớp đúng giá trị hợp đồng (${value.toLocaleString('vi-VN')})`, 'error');
    loading(true);

    const { data: newContract, error } = await supabase
      .from('contracts')
      .insert({ project_id, partner_id, contract_type, value, signed_date, retention_rate, vat_rate, template_id: template_id || null, to_trinh_id, created_by: user.id, status: 'draft' })
      .select('id')
      .single();
    if (error) return toast('Lỗi tạo hợp đồng: ' + error.message, 'error');

    await supabase.from('contract_budget_lines').insert(lines.map((l) => ({ contract_id: newContract.id, budget_code: l.budget_code, value: l.value })));
    await uploadStagedFiles(filePicker.getFiles(), 'contract', newContract.id, user.id);

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
