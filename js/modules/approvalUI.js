// ============================================================
// approvalUI.js — Phần dùng chung cho luồng phê duyệt: vẽ rail 4 bước,
// vẽ lịch sử, và nút Trình/Duyệt/Từ chối/Trình lại nối thẳng vào RPC.
// Dùng chung cho hopdong.js, bill.js, totrinh.js — không viết lại mỗi module.
// ============================================================
import { supabase } from './config.js';
import { toast, loading, fmtDateTime } from './utils.js';

const STEP_LABEL = { 1: 'Bước 1', 2: 'Bước 2', 3: 'Bước 3', 4: 'Bước 4' };

// Lấy trạng thái duyệt hiện tại (theo từng người) + lịch sử thao tác của 1 hồ sơ
export async function loadApprovalState(docType, docId) {
  const [{ data: assignments }, { data: logs }] = await Promise.all([
    supabase
      .from('approval_assignments')
      .select('step_no, role_type, status, user_id, acted_at, users(full_name)')
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
export function railHtml(assignments, currentStep) {
  const byStep = {};
  assignments.forEach((a) => {
    (byStep[a.step_no] = byStep[a.step_no] || []).push(a);
  });
  const steps = [1, 2, 3, 4].map((s) => ({
    step: s,
    people: byStep[s] || [],
    doneAll: (byStep[s] || []).length > 0 && (byStep[s] || []).every((p) => p.status === 'approved'),
  }));

  return `<div class="rail">${steps
    .map((s) => {
      const cls = s.doneAll ? 'done' : s.step === currentStep ? 'active' : '';
      return `<div class="rail-step ${cls}">
        <div class="rail-node">${s.doneAll ? '✓' : s.step}</div>
        <div class="rail-label">${STEP_LABEL[s.step]}</div>
        <div class="rail-people">${s.people
          .map(
            (p) =>
              `<div class="pp ${p.status}"><span class="tick">${p.status === 'approved' ? '✓' : p.status === 'rejected' ? '✕' : ''}</span>${p.users?.full_name || '—'} <span style="opacity:.6">(${p.role_type})</span></div>`,
          )
          .join('') || '<div class="pp" style="opacity:.5">—</div>'}</div>
      </div>`;
    })
    .join('')}</div>`;
}

export function timelineHtml(logs) {
  if (!logs.length) return `<div class="empty-note" style="padding:16px 0">Chưa có lịch sử</div>`;
  const actionLabel = { submit: 'Trình hồ sơ', resubmit: 'Trình lại', approve: 'Đã duyệt', reject: 'Từ chối' };
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

// Nút hành động — quyết định hiện gì dựa trên trạng thái hồ sơ + việc người
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
    return `<div class="panel-footer">
      <button class="btn btn-secondary" id="btnRemind">Nhắc duyệt</button>
      <button class="btn btn-danger" id="btnReject" style="flex:1">Từ chối</button>
      <button class="btn btn-primary" id="btnApprove" style="flex:1">Duyệt</button>
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
    loading(true);
    const { error } = await supabase.rpc('fn_approve_document', { p_doc_type: docType, p_doc_id: docId, p_comment: null });
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
    for (const uid of pendingUserIds) {
      await supabase.from('notifications').insert({ document_type: docType, document_id: docId, user_id: uid, channel: 'email', trigger_type: 'manual_nudge' });
    }
    toast('Đã gửi nhắc duyệt', 'success');
  });
}
