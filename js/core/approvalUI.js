// ============================================================
// approvalUI.js — Phần dùng chung cho luồng phê duyệt: vẽ rail 4 bước,
// vẽ lịch sử, và nút Trình/Duyệt/Từ chối/Trình lại nối thẳng vào RPC.
// Dùng chung cho hopdong.js, bill.js, totrinh.js — không viết lại mỗi module.
// ============================================================
import { supabase } from './config.js';
import { toast, loading, fmtDateTime, formatMoneyInput, parseMoneyInput } from './utils.js';

const STEP_LABEL = { 1: 'Bước 1', 2: 'Bước 2', 3: 'Bước 3', 4: 'Bước 4' };

// Lấy trạng thái duyệt hiện tại (theo từng người) + lịch sử thao tác của 1 hồ sơ
export async function loadApprovalState(docType, docId) {
  const [{ data: assignments }, { data: logs }] = await Promise.all([
    supabase
      .from('approval_assignments')
      .select('step_no, role_type, status, user_id, created_at, acted_at, users(full_name)')
      .eq('document_type', docType)
      .eq('document_id', docId)
      .order('step_no'),
    supabase
      .from('approval_logs')
      .select('step_no, action, comment, created_at, users(full_name)')
      .eq('document_type', docType)
      .eq('document_id', docId)
      .order('created_at'),
  ]);
  return { assignments: assignments || [], logs: logs || [] };
}

// Vẽ rail 4 bước — mỗi bước liệt kê từng người + trạng thái duyệt của riêng họ
// Xem trước ai SẼ duyệt ở các bước chưa tới (chưa có dữ liệu thật) — gọi cùng lúc
// với loadApprovalState, truyền kết quả vào railHtml qua tham số preview
export async function loadStepPreview(projectId, templateId, currentStep) {
  if (!templateId) return {};
  const futureSteps = [1, 2, 3, 4].filter((s) => s > currentStep);
  const results = await Promise.all(
    futureSteps.map((s) => supabase.rpc('fn_preview_step_assignees', { p_project_id: projectId, p_template_id: templateId, p_step_no: s })),
  );
  const preview = {};
  futureSteps.forEach((s, i) => (preview[s] = results[i].data || []));
  return preview;
}

export function railHtml(assignments, currentStep, preview = {}) {
  const byStep = {};
  assignments.forEach((a) => {
    (byStep[a.step_no] = byStep[a.step_no] || []).push(a);
  });
  const steps = [1, 2, 3, 4].map((s) => ({
    step: s,
    people: byStep[s] || [],
    doneAll: (byStep[s] || []).length > 0 && (byStep[s] || []).every((p) => p.status === 'approved'),
  }));

  // Bước 1-2: hạn 2 ngày (48h). Bước 3-4: hạn 1 ngày (24h). Tính trên chính bước đang chờ.
  const slaHours = (stepNo) => (stepNo <= 2 ? 48 : 24);
  const isOverdue = (p) => p.status === 'pending' && p.created_at && (Date.now() - new Date(p.created_at).getTime()) / 3600000 > slaHours(p.step_no);

  return `<div class="rail">${steps
    .map((s) => {
      const cls = s.doneAll ? 'done' : s.step === currentStep ? 'active' : '';
      const previewPeople = !s.people.length ? preview[s.step] || [] : [];
      return `<div class="rail-step ${cls}">
        <div class="rail-node">${s.doneAll ? '✓' : s.step}</div>
        <div class="rail-label">${STEP_LABEL[s.step]}</div>
        <div class="rail-people">${
          s.people.length
            ? s.people
                .map(
                  (p) =>
                    `<div class="pp ${p.status}"><span class="tick">${p.status === 'approved' ? '✓' : p.status === 'rejected' ? '✕' : ''}</span>${p.users?.full_name || '—'} <span style="opacity:.6">(${p.role_type})</span>${isOverdue(p) ? ' <span style="color:var(--red);font-weight:700">⚠️ Trễ</span>' : ''}</div>`,
                )
                .join('')
            : previewPeople.length
              ? previewPeople
                  .map((p) => `<div class="pp" style="opacity:.65;font-style:italic">${p.full_name || '(chưa có ai)'} <span style="opacity:.7">(${p.role_type}${p.department ? ' — ' + p.department : ''}) — dự kiến</span></div>`)
                  .join('')
              : '<div class="pp" style="opacity:.5">—</div>'
        }</div>
      </div>`;
    })
    .join('')}</div>`;
}

export function timelineHtml(logs) {
  if (!logs.length) return `<div class="empty-note" style="padding:16px 0">Chưa có lịch sử</div>`;
  const actionLabel = { submit: 'Trình hồ sơ', resubmit: 'Trình lại', approve: 'Đã duyệt', reject: 'Từ chối', edit_budget: 'Điều chỉnh mã ngân sách (QLCP&HĐ)' };
  return logs
    .map(
      (l) => `<div class="tl-item">
      <div class="tl-dot ${l.action === 'reject' ? 'danger' : 'done'}"></div>
      <div class="tl-body"><b>${l.users?.full_name || '—'}</b> — ${actionLabel[l.action] || l.action}
        <div class="tl-time">${fmtDateTime(l.created_at)}</div>
        ${l.comment ? `<div class="tl-comment">"${l.comment}"</div>` : ''}
      </div></div>`,
    )
    .join('');
}

// Tự nhận diện đúng Mẫu hồ sơ phù hợp với người đang tạo hồ sơ — không bắt họ
// tự chọn giữa 1 danh sách lẫn lộn mẫu công trường/phòng ban khác nhau
export async function resolveDefaultTemplates(userId, docType) {
  const { data: myRoles } = await supabase.from('user_roles').select('role_type, department').eq('user_id', userId);
  const depts = (myRoles || []).filter((r) => r.role_type === 'ChuyenVienPhongBan' && r.department).map((r) => r.department);

  let templates = [];
  if (depts.length) {
    const { data: matchSteps } = await supabase
      .from('template_steps')
      .select('template_id, document_templates!inner(id, name, doc_type)')
      .eq('role_type', 'ChuyenVienPhongBan')
      .in('department', depts)
      .eq('document_templates.doc_type', docType);
    const ids = [...new Set((matchSteps || []).map((s) => s.template_id))];
    if (ids.length) {
      const { data } = await supabase.from('document_templates').select('id, name').in('id', ids);
      templates = data || [];
    }
  }
  if (!templates.length) {
    const { data } = await supabase.from('document_templates').select('id, name').eq('doc_type', docType).eq('origin_scope', 'site');
    templates = data || [];
  }
  if (!templates.length) {
    const { data } = await supabase.from('document_templates').select('id, name').eq('doc_type', docType);
    templates = data || [];
  }
  return templates;
}

// ============================================================
// Chia nhiều dòng mã ngân sách — dùng chung cho form Hợp đồng và Bill
// ============================================================

export function budgetLineRowHtml(categories, code = '', value = '') {
  return `<div class="budget-line-row" style="display:flex;gap:8px;margin-bottom:8px;align-items:center">
    <select class="bl-code form-input" style="flex:1.3">${categories.map((c) => `<option value="${c.code}" ${c.code === code ? 'selected' : ''}>${c.code} — ${c.name}</option>`).join('')}</select>
    <input type="text" inputmode="numeric" class="bl-value form-input money-input" style="flex:1" placeholder="Giá trị" value="${value ? formatMoneyInput(value) : ''}">
    <button type="button" class="bl-remove btn btn-sm btn-secondary" style="flex:none">✕</button>
  </div>`;
}

// wrapEl phải chứa: .bl-rows (nơi đặt các dòng), .bl-add (nút thêm dòng), .bl-total (nơi hiện tổng)
export function wireBudgetLines(wrapEl, categories, targetValueSelector) {
  function updateTotal() {
    const rows = [...wrapEl.querySelectorAll('.budget-line-row')];
    const total = rows.reduce((s, r) => s + parseMoneyInput(r.querySelector('.bl-value').value), 0);
    const targetEl = document.querySelector(targetValueSelector);
    const target = targetEl ? Number(targetEl.value) || 0 : 0;
    const totalEl = wrapEl.querySelector('.bl-total');
    if (totalEl) {
      totalEl.textContent = `Tổng đã chia: ${total.toLocaleString('vi-VN')} / ${target.toLocaleString('vi-VN')} ₫`;
      totalEl.style.color = total === target ? 'var(--green)' : 'var(--red)';
    }
    return total;
  }
  wrapEl.addEventListener('input', (e) => {
    if (e.target.classList.contains('bl-value')) updateTotal();
  });
  wrapEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('bl-remove')) {
      if (wrapEl.querySelectorAll('.budget-line-row').length <= 1) return;
      e.target.closest('.budget-line-row').remove();
      updateTotal();
    }
  });
  wrapEl.querySelector('.bl-add')?.addEventListener('click', () => {
    wrapEl.querySelector('.bl-rows').insertAdjacentHTML('beforeend', budgetLineRowHtml(categories));
    updateTotal();
  });
  document.querySelector(targetValueSelector)?.addEventListener('input', updateTotal);
  updateTotal();
  return updateTotal;
}

export function readBudgetLines(wrapEl) {
  return [...wrapEl.querySelectorAll('.budget-line-row')]
    .map((r) => ({ budget_code: r.querySelector('.bl-code').value, value: parseMoneyInput(r.querySelector('.bl-value').value) }))
    .filter((l) => l.value > 0);
}

// đang đăng nhập có đang là người cần xử lý bước hiện tại hay không
export function actionFooterHtml(doc, docType, user, assignments) {
  const myPending = assignments.find((a) => a.step_no === doc.current_step && a.user_id === user.id && a.status === 'pending');

  if (doc.status === 'draft' && doc.created_by === user.id) {
    return `<div class="panel-footer"><button class="btn btn-primary" id="btnSubmit" style="flex:1">Trình duyệt</button></div>`;
  }
  if (doc.status === 'rejected' && doc.created_by === user.id) {
    return `<div class="panel-footer"><button class="btn btn-primary" id="btnResubmit" style="flex:1">Trình lại</button></div>`;
  }
  if (doc.status === 'pending' && myPending) {
    return `<div class="panel-footer" style="flex-direction:column;align-items:stretch;gap:8px">
      <textarea id="approveNote" class="form-input" rows="2" placeholder="Ghi chú khi duyệt (không bắt buộc) — để trống nếu không có ý kiến gì thêm"></textarea>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary" id="btnRemind">Nhắc duyệt</button>
        <button class="btn btn-danger" id="btnReject" style="flex:1">Từ chối</button>
        <button class="btn btn-primary" id="btnApprove" style="flex:1">Duyệt</button>
      </div>
    </div>`;
  }
  return `<div class="panel-footer"><span style="font-size:12.5px;color:var(--gray5)">Không có hành động nào khả dụng cho bạn ở hồ sơ này.</span></div>`;
}

// Gắn sự kiện cho các nút trên — gọi thẳng 4 hàm RPC đã viết ở database
export function wireActions(container, docType, docId, currentStep, assignments, onDone) {
  container.querySelector('#btnSubmit')?.addEventListener('click', async () => {
    loading(true);
    const { error } = await supabase.rpc('fn_submit_document', { p_doc_type: docType, p_doc_id: docId });
    if (error) return toast('Lỗi: ' + error.message, 'error');
    toast('Đã trình hồ sơ', 'success');
    onDone();
  });

  container.querySelector('#btnResubmit')?.addEventListener('click', async () => {
    loading(true);
    const { error } = await supabase.rpc('fn_resubmit_document', { p_doc_type: docType, p_doc_id: docId });
    if (error) return toast('Lỗi: ' + error.message, 'error');
    toast('Đã trình lại', 'success');
    onDone();
  });

  container.querySelector('#btnApprove')?.addEventListener('click', async () => {
    const note = container.querySelector('#approveNote')?.value.trim() || null;
    loading(true);
    const { error } = await supabase.rpc('fn_approve_document', { p_doc_type: docType, p_doc_id: docId, p_comment: note });
    if (error) return toast('Lỗi: ' + error.message, 'error');
    toast('Đã duyệt', 'success');
    onDone();
  });

  container.querySelector('#btnReject')?.addEventListener('click', async () => {
    const comment = prompt('Lý do từ chối (bắt buộc):');
    if (!comment || !comment.trim()) return toast('Phải nhập lý do từ chối', 'error');
    loading(true);
    const { error } = await supabase.rpc('fn_reject_document', { p_doc_type: docType, p_doc_id: docId, p_comment: comment });
    if (error) return toast('Lỗi: ' + error.message, 'error');
    toast('Đã từ chối — quay về người trình', 'success');
    onDone();
  });

  container.querySelector('#btnRemind')?.addEventListener('click', async () => {
    // Ghi thẳng vào bảng notifications — trigger sẽ tự gọi Edge Function gửi email/push
    const pendingUserIds = assignments.filter((a) => a.step_no === currentStep && a.status === 'pending').map((a) => a.user_id);
    if (!pendingUserIds.length) return toast('Không còn ai chưa duyệt ở bước này', 'info');
    let okCount = 0;
    let lastError = null;
    for (const uid of pendingUserIds) {
      const { error } = await supabase.from('notifications').insert({ document_type: docType, document_id: docId, user_id: uid, channel: 'email', trigger_type: 'manual_nudge' });
      if (error) lastError = error;
      else okCount++;
    }
    if (okCount > 0) toast(`Đã gửi nhắc duyệt (${okCount}/${pendingUserIds.length} người)`, 'success');
    if (lastError) toast('Lỗi gửi nhắc: ' + lastError.message, 'error');
  });
}
