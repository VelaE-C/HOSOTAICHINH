// ============================================================
// approvalUI.js — Phần dùng chung cho luồng phê duyệt: vẽ rail 4 bước,
// vẽ lịch sử, và nút Trình/Duyệt/Từ chối/Trình lại nối thẳng vào RPC.
// Dùng chung cho hopdong.js, bill.js, totrinh.js — không viết lại mỗi module.
// ============================================================
import { supabase } from './config.js';
import { toast, loading, fmtDateTime, formatMoneyInput, parseMoneyInput } from './utils.js';
import { uploadLogAttachment, offerAttachOneFile, getFileUrl } from './attachments.js';

const STEP_LABEL = { 1: 'Bước 1', 2: 'Bước 2', 3: 'Bước 3', 4: 'Bước 4' };

// Lấy trạng thái duyệt hiện tại (theo từng người) + lịch sử thao tác của 1 hồ sơ
// + ảnh/file đính kèm riêng theo từng dòng lịch sử (nếu có, VD ảnh minh họa lúc
// Từ chối) — gộp vào 1 map logId -> [file...] để timelineHtml() vẽ ra thumbnail.
export async function loadApprovalState(docType, docId) {
  const [{ data: assignments, error: e1 }, { data: logs, error: e2 }] = await Promise.all([
    supabase
      .from('approval_assignments')
      .select('step_no, role_type, status, user_id, created_at, acted_at, acted_by_admin_id, admin_override_reason, users!user_id(full_name, job_title), admin_override_users:users!acted_by_admin_id(full_name)')
      .eq('document_type', docType)
      .eq('document_id', docId)
      .order('step_no'),
    supabase
      .from('approval_logs')
      .select('id, step_no, action, comment, created_at, users(full_name)')
      .eq('document_type', docType)
      .eq('document_id', docId)
      .order('created_at'),
  ]);
  if (e1) console.error('Lỗi tải luồng phê duyệt (approval_assignments):', e1);
  if (e2) console.error('Lỗi tải lịch sử (approval_logs):', e2);

  const logAttachments = {};
  const logIds = (logs || []).map((l) => l.id).filter(Boolean);
  if (logIds.length) {
    const { data: atts } = await supabase.from('attachments').select('id, approval_log_id, file_name, file_url, file_size_kb').in('approval_log_id', logIds);
    (atts || []).forEach((a) => {
      (logAttachments[a.approval_log_id] ||= []).push(a);
    });
  }

  return { assignments: assignments || [], logs: logs || [], logAttachments };
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
                    `<div class="pp ${p.status}"><span class="tick">${p.status === 'approved' ? '✓' : p.status === 'rejected' ? '✕' : ''}</span>${p.users?.full_name || '—'} <span style="opacity:.6">(${p.role_type})</span>${isOverdue(p) ? ' <span style="color:var(--red);font-weight:700">⚠️ Trễ</span>' : ''}${p.acted_by_admin_id ? `<div style="color:var(--amber);font-size:11px;font-weight:600" title="${(p.admin_override_reason || '').replace(/"/g, '&quot;')}">⚠️ Admin ${p.status === 'rejected' ? 'từ chối' : 'duyệt'} thay</div>` : ''}</div>`,
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

export function timelineHtml(logs, logAttachments = {}) {
  if (!logs.length) return `<div class="empty-note" style="padding:16px 0">Chưa có lịch sử</div>`;
  const actionLabel = {
    submit: 'Trình hồ sơ',
    resubmit: 'Trình lại',
    approve: 'Đã duyệt',
    reject: 'Từ chối',
    approve_on_behalf: '⚠️ Admin duyệt thay',
    reject_on_behalf: '⚠️ Admin từ chối thay',
    edit_budget: 'Điều chỉnh mã ngân sách (QLCP&HĐ)',
    edit_doc_number: 'Sửa số hồ sơ (QLCP&HĐ)',
    cancel: 'Đã hủy hồ sơ (Admin)',
  };
  return logs
    .map((l) => {
      const atts = logAttachments[l.id] || [];
      return `<div class="tl-item">
      <div class="tl-dot ${l.action === 'reject' || l.action === 'reject_on_behalf' ? 'danger' : 'done'}"></div>
      <div class="tl-body"><b>${l.users?.full_name || '—'}</b> — ${actionLabel[l.action] || l.action}
        <div class="tl-time">${fmtDateTime(l.created_at)}</div>
        ${l.comment ? `<div class="tl-comment">"${l.comment}"</div>` : ''}
        ${atts.length ? atts.map((a) => `<span class="tl-attach" data-att-path="${a.file_url}" style="margin-top:6px;display:inline-flex;align-items:center;gap:4px;background:var(--gray1);padding:4px 9px;border-radius:6px;cursor:pointer;font-size:12px;color:var(--gray7)">🖼️ ${a.file_name}</span>`).join('') : ''}
      </div></div>`;
    })
    .join('');
}

// Gọi SAU KHI đã chèn timelineHtml(...) vào DOM — gắn sự kiện bấm mở ảnh/file đính
// kèm theo từng dòng Lịch sử (nếu có).
export function wireTimelineAttachments(container) {
  container.querySelectorAll('.tl-attach').forEach((el) =>
    el.addEventListener('click', async () => {
      try {
        const url = await getFileUrl(el.dataset.attPath);
        window.open(url, '_blank');
      } catch (err) {
        toast('Không mở được file: ' + err.message, 'error');
      }
    }),
  );
}

// Tự nhận diện đúng Mẫu hồ sơ phù hợp với người đang tạo hồ sơ — không bắt họ
// tự chọn giữa 1 danh sách lẫn lộn mẫu công trường/phòng ban khác nhau
export async function resolveDefaultTemplates(userId, docType) {
  const { data: myRoles } = await supabase.from('user_roles').select('role_type, department').eq('user_id', userId);
  const depts = (myRoles || []).filter((r) => r.role_type === 'ChuyenVienPhongBan' && r.department).map((r) => r.department);

  let deptTemplates = [];
  if (depts.length) {
    // Lấy TẤT CẢ bước "ChuyenVienPhongBan" của đúng loại hồ sơ này trước, rồi lọc
    // lại ở đây — KHÔNG lọc department ngay trong câu truy vấn nữa. Lý do: 1 mẫu
    // hồ sơ có thể để department = NULL (dùng CHUNG được cho MỌI phòng ban, VD
    // "Luồng 1"/"Luồng 2" khối văn phòng) — nếu lọc .in('department', depts) ngay
    // trong SQL thì NULL sẽ KHÔNG BAO GIỜ khớp được (đúng hành vi SQL), khiến các
    // mẫu dùng chung này biến mất khỏi danh sách của mọi Chuyên viên.
    const { data: matchSteps } = await supabase
      .from('template_steps')
      .select('template_id, department, document_templates!inner(id, name, doc_type, is_active)')
      .eq('role_type', 'ChuyenVienPhongBan')
      .eq('document_templates.doc_type', docType)
      .eq('document_templates.is_active', true);
    // department NULL = dùng chung mọi phòng ban -> luôn khớp.
    // department có giá trị = chỉ khớp đúng phòng ban của người này.
    const ids = [...new Set((matchSteps || []).filter((s) => s.department === null || depts.includes(s.department)).map((s) => s.template_id))];
    if (ids.length) {
      const { data } = await supabase.from('document_templates').select('id, name').in('id', ids);
      deptTemplates = data || [];
    }
  }

  // ĐÃ SỬA: mẫu "site" (công trường) giờ LUÔN được lấy thêm và GỘP CHUNG với mẫu
  // phòng ban (nếu có) — KHÔNG còn là "chỉ lấy khi không tìm thấy mẫu phòng ban
  // nào" như bản trước. Lý do: 1 người có thể VỪA là QS (công trường) VỪA là
  // Chuyên viên phòng ban cùng lúc — nếu chỉ lấy 1 trong 2, người đó sẽ mất hẳn
  // khả năng thấy mẫu công trường bình thường khi họ cũng có vai trò phòng ban.
  const { data: siteTemplates } = await supabase.from('document_templates').select('id, name').eq('doc_type', docType).eq('origin_scope', 'site').eq('is_active', true);

  const merged = [...deptTemplates, ...(siteTemplates || [])];
  let templates = [...new Map(merged.map((t) => [t.id, t])).values()];

  if (!templates.length) {
    const { data } = await supabase.from('document_templates').select('id, name').eq('doc_type', docType).eq('is_active', true);
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
// isAdmin (mặc định false) — nếu true, luôn hiện thêm khối "Duyệt/Từ chối THAY" ở dưới
// cho phép Admin xử lý thay bất kỳ ai đang đứng tên chờ duyệt ở bước hiện tại, không cần
// chính Admin nằm trong danh sách người duyệt của bước đó. Bắt buộc lý do, KHÔNG ẩn dấu
// vết — mọi hành động vẫn ghi rõ "Admin duyệt/từ chối thay [tên]" trên rail/lịch sử/PDF.
export function actionFooterHtml(doc, docType, user, assignments, isAdmin = false) {
  const myPending = assignments.find((a) => a.step_no === doc.current_step && a.user_id === user.id && a.status === 'pending');
  const stepPendingList = assignments.filter((a) => a.step_no === doc.current_step && a.status === 'pending');

  let html = '';

  if (doc.status === 'draft' && doc.created_by === user.id) {
    return `<div class="panel-footer"><button class="btn btn-primary" id="btnSubmit" style="flex:1">Trình duyệt</button></div>`;
  }
  if (doc.status === 'rejected' && doc.created_by === user.id) {
    return `<div class="panel-footer"><button class="btn btn-primary" id="btnResubmit" style="flex:1">Trình lại</button></div>`;
  }
  if (doc.status === 'pending' && myPending) {
    html += `<div class="panel-footer" style="flex-direction:column;align-items:stretch;gap:8px">
      <textarea id="approveNote" class="form-input" rows="2" placeholder="Ghi chú khi duyệt (không bắt buộc) — để trống nếu không có ý kiến gì thêm"></textarea>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary" id="btnRemind">Nhắc duyệt</button>
        <button class="btn btn-danger" id="btnReject" style="flex:1">Từ chối</button>
        <button class="btn btn-primary" id="btnApprove" style="flex:1">Duyệt</button>
      </div>
    </div>`;
  } else if (doc.status === 'pending' && doc.created_by === user.id) {
    // Người trình hồ sơ (không phải người duyệt ở bước hiện tại) vẫn nên nhắc được
    // — họ là người chờ kết quả, có lợi ích chính đáng để thúc tiến độ.
    html += `<div class="panel-footer"><button class="btn btn-secondary" id="btnRemind" style="flex:1">Nhắc duyệt</button></div>`;
  }

  if (isAdmin && doc.status === 'pending' && stepPendingList.length) {
    html += `<div class="panel-footer" style="flex-direction:column;align-items:stretch;gap:8px;border-top:2px dashed var(--amber);${html ? 'margin-top:10px' : ''}">
      <div style="font-size:12px;font-weight:700;color:var(--amber)">⚠️ Duyệt/Từ chối THAY (chỉ Admin thấy mục này)</div>
      <select id="onBehalfUser" class="form-input">
        ${stepPendingList.map((a) => `<option value="${a.user_id}">${a.users?.full_name || '—'} (${a.role_type})</option>`).join('')}
      </select>
      <textarea id="onBehalfReason" class="form-input" rows="2" placeholder="Lý do duyệt/từ chối thay (bắt buộc) — VD: Nghỉ phép, đang off tạm thời"></textarea>
      <div style="display:flex;gap:8px">
        <button class="btn btn-danger" id="btnRejectOnBehalf" style="flex:1">Từ chối thay</button>
        <button class="btn btn-primary" id="btnApproveOnBehalf" style="flex:1">Duyệt thay</button>
      </div>
    </div>`;
  }

  return html || `<div class="panel-footer"><span style="font-size:12.5px;color:var(--gray5)">Không có hành động nào khả dụng cho bạn ở hồ sơ này.</span></div>`;
}

// Gắn sự kiện cho các nút trên — gọi thẳng 4 hàm RPC đã viết ở database.
// currentUserId: dùng để ghi "uploaded_by" khi có đính kèm ảnh minh họa lúc Từ
// chối (không đổi được RPC fn_reject_document — chỉ truy vấn lại đúng dòng Lịch
// sử VỪA tạo, ngay sau khi Từ chối thành công, để gắn ảnh vào đúng chỗ).
export function wireActions(container, docType, docId, currentStep, assignments, onDone, currentUserId) {
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

  // Lấy đúng dòng Lịch sử vừa tạo (mới nhất, đúng loại reject) để gắn ảnh minh
  // họa (nếu có chọn) — không cần sửa RPC, chỉ truy vấn lại ngay sau khi thành công.
  async function findJustCreatedRejectLogId(actionType) {
    const { data } = await supabase
      .from('approval_logs')
      .select('id')
      .eq('document_type', docType)
      .eq('document_id', docId)
      .eq('action', actionType)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data?.id || null;
  }

  container.querySelector('#btnReject')?.addEventListener('click', async () => {
    const comment = prompt('Lý do từ chối (bắt buộc):');
    if (!comment || !comment.trim()) return toast('Phải nhập lý do từ chối', 'error');
    loading(true);
    const { error } = await supabase.rpc('fn_reject_document', { p_doc_type: docType, p_doc_id: docId, p_comment: comment });
    if (error) return toast('Lỗi: ' + error.message, 'error');
    toast('Đã từ chối — quay về người trình', 'success');
    const logId = await findJustCreatedRejectLogId('reject');
    if (logId) {
      // offerAttachOneFile tự hiện nút "Chọn ảnh"/"Bỏ qua" riêng — KHÔNG dùng
      // confirm() nữa, vì sau 2 lần await (RPC + tra lại Lịch sử) ở trên, trình
      // duyệt coi cú bấm gốc đã "nguội", sẽ âm thầm chặn việc tự mở hộp thoại
      // chọn file nếu gọi ngay sau confirm() — phải là 1 cú bấm chuột thật mới.
      await offerAttachOneFile(docType, docId, logId, currentUserId);
    }
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

  // Admin duyệt/từ chối THAY người đang chờ duyệt ở bước hiện tại — bắt buộc lý do,
  // KHÔNG ẩn dấu vết (RPC tự ghi rõ "Admin duyệt/từ chối thay [tên]" vào approval_logs).
  container.querySelector('#btnApproveOnBehalf')?.addEventListener('click', async () => {
    const onBehalfUserId = container.querySelector('#onBehalfUser')?.value;
    const reason = container.querySelector('#onBehalfReason')?.value.trim();
    if (!reason) return toast('Phải nhập lý do duyệt thay', 'error');
    loading(true);
    const { error } = await supabase.rpc('fn_approve_document', { p_doc_type: docType, p_doc_id: docId, p_comment: reason, p_on_behalf_user_id: onBehalfUserId });
    if (error) return toast('Lỗi: ' + error.message, 'error');
    toast('Đã duyệt thay', 'success');
    onDone();
  });

  container.querySelector('#btnRejectOnBehalf')?.addEventListener('click', async () => {
    const onBehalfUserId = container.querySelector('#onBehalfUser')?.value;
    const reason = container.querySelector('#onBehalfReason')?.value.trim();
    if (!reason) return toast('Phải nhập lý do từ chối thay', 'error');
    if (!confirm('Xác nhận TỪ CHỐI THAY hồ sơ này? Hồ sơ sẽ quay về người trình.')) return;
    loading(true);
    const { error } = await supabase.rpc('fn_reject_document', { p_doc_type: docType, p_doc_id: docId, p_comment: reason, p_on_behalf_user_id: onBehalfUserId });
    if (error) return toast('Lỗi: ' + error.message, 'error');
    toast('Đã từ chối thay — quay về người trình', 'success');
    const logId = await findJustCreatedRejectLogId('reject_on_behalf');
    if (logId) {
      // offerAttachOneFile tự hiện nút "Chọn ảnh"/"Bỏ qua" riêng — KHÔNG dùng
      // confirm() nữa, vì sau 2 lần await (RPC + tra lại Lịch sử) ở trên, trình
      // duyệt coi cú bấm gốc đã "nguội", sẽ âm thầm chặn việc tự mở hộp thoại
      // chọn file nếu gọi ngay sau confirm() — phải là 1 cú bấm chuột thật mới.
      await offerAttachOneFile(docType, docId, logId, currentUserId);
    }
    onDone();
  });
}
