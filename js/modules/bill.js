// ============================================================
// bill.js — Module Bill thanh toán theo kỳ
// Công thức: C=A+B | E=-10%×D | G = F==0 ? 0 : -F×(D/(0.8×A)) | H=D+E+F+G | J=H+I
// ============================================================
import { supabase } from '../core/config.js';
import { fmt, toast, loading, statusBadge } from '../core/utils.js';
import { loadApprovalState, railHtml, timelineHtml, actionFooterHtml, wireActions, resolveDefaultTemplates } from '../core/approvalUI.js';
import { renderAttachments } from '../core/attachments.js';

let VIEW_PROJECT = 'ALL';

function calcBill(b) {
  const C = Number(b.val_a) + Number(b.val_b);
  const E = -0.1 * Number(b.val_d);
  const G = Number(b.val_f) === 0 ? 0 : -Number(b.val_f) * (Number(b.val_d) / (0.8 * Number(b.val_a)));
  const H = Number(b.val_d) + E + Number(b.val_f) + G;
  const J = H + Number(b.val_i);
  return { C, E, G, H, J };
}

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải…</div>`;

  const { data: projects } = await supabase.from('projects').select('id, code, name').order('code');
  let q = supabase
    .from('bills')
    .select('id, doc_number, period_no, val_a, val_b, val_d, val_f, val_i, status, current_step, checklist_required, checklist_done, project_id, created_at, partners(name)')
    .order('created_at', { ascending: false });
  if (VIEW_PROJECT !== 'ALL') q = q.eq('project_id', VIEW_PROJECT);
  const { data: bills, error } = await q;

  if (error) {
    container.innerHTML = `<div class="empty-note">⚠️ Lỗi tải dữ liệu: ${error.message}</div>`;
    return;
  }

  const sorted = [...(bills || [])].sort((a, b) => {
    const ad = a.status === 'closed' ? 1 : 0;
    const bd = b.status === 'closed' ? 1 : 0;
    if (ad !== bd) return ad - bd;
    return new Date(b.created_at) - new Date(a.created_at);
  });

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;margin-bottom:12px;gap:10px;flex-wrap:wrap">
      <select class="btn btn-secondary" id="projFilter">
        <option value="ALL" ${VIEW_PROJECT === 'ALL' ? 'selected' : ''}>Tất cả dự án</option>
        ${(projects || []).map((p) => `<option value="${p.id}" ${VIEW_PROJECT === p.id ? 'selected' : ''}>${p.code} — ${p.name}</option>`).join('')}
      </select>
      <button class="btn btn-primary" id="btnNew">+ Trình bill thanh toán</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden"><table><thead><tr><th>Số hồ sơ</th><th>Đối tác</th><th>Kỳ</th><th>Đề nghị (J)</th><th>Checklist</th><th>Trạng thái</th></tr></thead><tbody>
    ${sorted.length ? sorted.map((b) => {
      const { J } = calcBill(b);
      const req = b.checklist_required || 0;
      const done = b.checklist_done || 0;
      return `<tr class="click" data-id="${b.id}"><td class="mono">${b.doc_number}</td><td>${b.partners?.name || '—'}</td><td>Kỳ ${b.period_no}</td>
      <td class="mono">${fmt(J)}</td><td>${req ? (done < req ? `<span style="color:var(--amber)">${done}/${req} ⚠️</span>` : `<span style="color:var(--green)">${done}/${req} ✓</span>`) : '—'}</td>
      <td>${statusBadge(b.status)}</td></tr>`;
    }).join('') : `<tr><td colspan="6" style="text-align:center;color:var(--gray4);padding:20px">Chưa có bill nào</td></tr>`}
    </tbody></table></div>`;

  container.querySelector('#projFilter').addEventListener('change', (e) => {
    VIEW_PROJECT = e.target.value;
    render(container, user);
  });
  container.querySelector('#btnNew').addEventListener('click', () => openCreateModal(user, () => render(container, user)));
  container.querySelectorAll('[data-id]').forEach((r) => r.addEventListener('click', () => openDetail(r.dataset.id, user, () => render(container, user))));
}

function finRow(label, value, code, bold) {
  return `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--gray1);${bold ? 'font-weight:700;' : ''}">
    <span style="font-size:12.5px;color:${bold ? 'var(--gray8)' : 'var(--gray7)'}">${label}</span>
    <span style="display:flex;align-items:center;gap:10px">
      <span class="mono" style="font-size:13px;${bold ? 'font-weight:700;color:var(--navy)' : ''}">${value === 0 ? '—' : fmt(value) + ' ₫'}</span>
      <span style="font-size:10.5px;color:var(--gray4);width:60px;text-align:left">${code}</span>
    </span></div>`;
}

export async function openDetail(id, user, onClose) {
  const modal = ensureModal();
  modal.innerHTML = `<div class="panel-box"><div class="empty-note">Đang tải…</div></div>`;
  showModal(modal, onClose);

  const { data: b } = await supabase
    .from('bills')
    .select('*, partners(name), projects(name), contracts(doc_number, value), bill_budget_lines(budget_code, value)')
    .eq('id', id)
    .single();
  if (!b) {
    modal.querySelector('.panel-box').innerHTML = `<div class="empty-note">Không tải được hồ sơ.</div>`;
    return;
  }
  const r = calcBill(b);
  const { assignments, logs } = await loadApprovalState('bill', id);
  const req = b.checklist_required || 0;
  const { count: attachCount } = await supabase.from('attachments').select('id', { count: 'exact', head: true }).eq('owner_type', 'bill').eq('owner_id', id);
  const done = attachCount || 0;

  const box = modal.querySelector('.panel-box');
  box.innerHTML = `
    <div class="panel-header"><div><div>${b.doc_number}</div><div class="meta">Kỳ ${b.period_no} · ${b.partners?.name || '—'}</div></div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      ${b.contract_ceiling_flag ? `<div class="warn-box">⚠️ <div><b>Case 1 — Lũy kế thực hiện đã vượt giá trị hợp đồng.</b> Vẫn duyệt bình thường; cần bổ sung phụ lục hợp đồng để hợp thức hóa.</div></div>` : ''}
      <div class="kv">
        <div class="k">Gói thầu</div><div class="v" style="font-weight:600">${b.scope || '—'}</div>
        <div class="k">Trạng thái</div><div class="v">${statusBadge(b.status)}</div>
        <div class="k">Hợp đồng liên kết</div><div class="v">${b.contracts ? `<span class="code-chip">${b.contracts.doc_number}</span>` : '<span style="color:var(--amber)">⚠️ Chưa gắn hợp đồng</span>'}</div>
        <div class="k">Chia mã ngân sách</div><div class="v">${(b.bill_budget_lines || []).map((l) => `<div class="budget-line"><span class="code-chip">${l.budget_code}</span><span class="mono">${fmt(l.value)} ₫</span></div>`).join('') || '—'}</div>
      </div>
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Chi tiết hợp đồng</div>
      <div class="card" style="padding:4px 14px">
        ${finRow('Giá trị hợp đồng ban đầu', b.val_a, 'A')}
        ${finRow('Điều chỉnh hợp đồng', b.val_b, 'B')}
        ${finRow('Giá trị hợp đồng điều chỉnh', r.C, 'C = A+B', true)}
      </div>
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Chi tiết thanh toán</div>
      <div class="card" style="padding:4px 14px">
        ${finRow('Giá trị thực hiện lũy kế đến kỳ này', b.val_d, 'D')}
        ${finRow('Tổng giá trị tiền giữ lại', r.E, 'E = -10%×D')}
        ${finRow('Giá trị tạm ứng', b.val_f, 'F')}
        ${finRow('Hoàn trả tạm ứng đến kỳ này', r.G, 'G')}
        ${finRow('Tổng giá trị thanh toán bao gồm tạm ứng', r.H, 'H = D+E+F+G', true)}
        ${finRow('Trừ các đợt thanh toán trước', b.val_i, 'I')}
        ${finRow('Số tiền phải thanh toán đợt này', r.J, 'J = H+I', true)}
      </div>
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Hồ sơ đính kèm</div>
      <div class="card" id="attachArea"></div>
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Checklist hồ sơ đính kèm</div>
      <div class="card"><div style="font-size:13px">${req ? `${done}/${req} hồ sơ bắt buộc đã có (tự đếm theo số file đính kèm ở trên)` : 'Chưa thiết lập checklist cho bill này'}</div>
      <div class="bar-track" style="margin-top:8px"><div class="bar-fill" style="width:${req ? (done / req * 100) : 0}%;background:${done >= req && req ? 'var(--green)' : 'var(--amber)'}"></div></div></div>
      ${b.status !== 'draft' ? `<div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Luồng phê duyệt</div>${railHtml(assignments, b.current_step)}
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5);margin-top:20px">Lịch sử</div>${timelineHtml(logs)}` : `<div class="empty-note">Hồ sơ đang ở trạng thái nháp.</div>`}
    </div>
    ${actionFooterHtml(b, 'bill', user, assignments)}
  `;
  box.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));
  renderAttachments(box.querySelector('#attachArea'), 'bill', id, user.id);
  wireActions(box, 'bill', id, b.current_step, assignments, () => closeModal(modal, onClose));
}

async function openCreateModal(user, onClose) {
  const modal = ensureModal();
  const { data: projects } = await supabase.from('projects').select('id, code, name').order('code');
  const { data: partners } = await supabase.from('partners').select('id, name, mst').order('name');
  const { data: contracts } = await supabase.from('contracts').select('id, doc_number, value, value_adjustment, project_id, partner_id').eq('status', 'active').order('doc_number');
  const { data: categories } = await supabase.from('budget_categories').select('code, name').order('code');
  const templates = await resolveDefaultTemplates(user.id, 'bill');

  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Trình bill thanh toán mới</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="margin-bottom:13px"><label class="form-label">Dự án</label>
        <select id="fProject" class="form-input">${(projects || []).map((p) => `<option value="${p.id}">${p.code} — ${p.name}</option>`).join('')}</select></div>
      <div style="margin-bottom:13px"><label class="form-label">Hợp đồng liên kết (không bắt buộc)</label>
        <select id="fContract" class="form-input"><option value="">— Chưa liên kết —</option>${(contracts || []).map((c) => `<option value="${c.id}" data-value="${c.value}" data-adj="${c.value_adjustment || 0}" data-partner="${c.partner_id}">${c.doc_number}</option>`).join('')}</select></div>
      <div style="margin-bottom:13px"><label class="form-label">Đối tác (NTP/NCC) *</label>
        <select id="fPartner" class="form-input">${(partners || []).map((p) => `<option value="${p.id}">${p.name} (MST ${p.mst})</option>`).join('')}</select>
        <div style="font-size:11px;color:var(--gray4);margin-top:4px">Tự điền theo hợp đồng liên kết nếu có chọn ở trên.</div></div>
      <div style="margin-bottom:13px"><label class="form-label">Kỳ số</label>
        <input type="number" id="fPeriod" class="form-input" value="1" min="1"></div>
      <div style="margin-bottom:13px"><label class="form-label">Gói thầu / nội dung kỳ này</label>
        <input type="text" id="fScope" class="form-input" placeholder="VD: Cung cấp bê tông tươi mác 300"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:13px">
        <div><label class="form-label">A — Giá trị HĐ ban đầu</label><input type="number" id="fA" class="form-input"></div>
        <div><label class="form-label">B — Điều chỉnh HĐ</label><input type="number" id="fB" class="form-input" value="0"></div>
        <div><label class="form-label">D — Lũy kế thực hiện kỳ này</label><input type="number" id="fD" class="form-input"></div>
        <div><label class="form-label">F — Giá trị tạm ứng</label><input type="number" id="fF" class="form-input" value="0"></div>
        <div style="grid-column:1/-1"><label class="form-label">I — Trừ các đợt thanh toán trước (số âm)</label><input type="number" id="fI" class="form-input" value="0"></div>
      </div>
      <div style="margin-bottom:13px"><label class="form-label">Chia theo mã ngân sách</label>
        <select id="fBudgetCode" class="form-input">${(categories || []).map((c) => `<option value="${c.code}">${c.code} — ${c.name}</option>`).join('')}</select></div>
      <div style="margin-bottom:13px"><label class="form-label">Số hồ sơ đính kèm bắt buộc (checklist)</label>
        <input type="number" id="fChecklist" class="form-input" value="5" min="0"></div>
      <div style="margin-bottom:13px"><label class="form-label">Mẫu hồ sơ (luồng duyệt)</label>
        <select id="fTemplate" class="form-input">${(templates || []).map((t) => `<option value="${t.id}">${t.name}</option>`).join('')}</select>
        <div style="font-size:11px;color:var(--gray4);margin-top:4px">${templates.length <= 1 ? 'Tự nhận diện đúng mẫu theo phòng ban/vai trò của bạn.' : 'Đã lọc sẵn các mẫu phù hợp với bạn.'}</div></div>
    </div>
    <div class="panel-footer">
      <button class="btn btn-secondary" id="btnSaveDraft">💾 Lưu nháp</button>
      <button class="btn btn-primary" id="btnSubmitNew">Trình duyệt</button>
    </div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  // Khi chọn hợp đồng liên kết, tự điền A, B, và Đối tác theo đúng hợp đồng đó
  modal.querySelector('#fContract').addEventListener('change', (e) => {
    const opt = e.target.selectedOptions[0];
    if (opt && opt.value) {
      modal.querySelector('#fA').value = opt.dataset.value || '';
      modal.querySelector('#fB').value = opt.dataset.adj || 0;
      if (opt.dataset.partner) modal.querySelector('#fPartner').value = opt.dataset.partner;
    }
  });

  async function doSave(submitAfter) {
    const project_id = modal.querySelector('#fProject').value;
    const contract_id = modal.querySelector('#fContract').value || null;
    const partner_id = modal.querySelector('#fPartner').value;
    const period_no = Number(modal.querySelector('#fPeriod').value);
    const scope = modal.querySelector('#fScope').value;
    const val_a = Number(modal.querySelector('#fA').value);
    const val_b = Number(modal.querySelector('#fB').value);
    const val_d = Number(modal.querySelector('#fD').value);
    const val_f = Number(modal.querySelector('#fF').value);
    const val_i = Number(modal.querySelector('#fI').value);
    const budget_code = modal.querySelector('#fBudgetCode').value;
    const checklist_required = Number(modal.querySelector('#fChecklist').value);
    const template_id = modal.querySelector('#fTemplate').value;

    if (!project_id || !partner_id || !val_a || !budget_code) return toast('Điền đủ thông tin bắt buộc (kể cả Đối tác)', 'error');

    // Quy tắc: kỳ N+1 chỉ tạo được khi kỳ N đã qua tối thiểu bước 2
    if (contract_id && period_no > 1) {
      const { data: prevBill } = await supabase
        .from('bills')
        .select('current_step, status')
        .eq('contract_id', contract_id)
        .eq('period_no', period_no - 1)
        .maybeSingle();
      if (!prevBill) return toast(`Chưa có bill kỳ ${period_no - 1} của hợp đồng này — phải tạo kỳ trước đó trước`, 'error');
      if (prevBill.status === 'draft' || prevBill.current_step < 2) {
        return toast(`Bill kỳ ${period_no - 1} chưa qua tối thiểu bước 2 — chưa tạo được kỳ ${period_no}`, 'error');
      }
    }

    loading(true);
    const { data: newBill, error } = await supabase
      .from('bills')
      .insert({ project_id, contract_id, partner_id, period_no, scope, val_a, val_b, val_d, val_f, val_i, checklist_required, template_id: template_id || null, created_by: user.id, status: 'draft' })
      .select('id')
      .single();
    if (error) return toast('Lỗi tạo bill: ' + error.message, 'error');

    await supabase.from('bill_budget_lines').insert({ bill_id: newBill.id, budget_code, value: calcBill({ val_a, val_b, val_d, val_f, val_i }).J });

    if (submitAfter) {
      const { error: subErr } = await supabase.rpc('fn_submit_document', { p_doc_type: 'bill', p_doc_id: newBill.id });
      if (subErr) return toast('Đã lưu nháp, nhưng trình lỗi: ' + subErr.message, 'error');
      toast('Đã trình bill', 'success');
      closeModal(modal, onClose);
    } else {
      toast('Đã lưu nháp — mở lại hồ sơ để đính kèm file', 'success');
      closeModal(modal, () => {}); // đóng form tạo, không refresh danh sách vội
      openDetail(newBill.id, user, onClose); // mở luôn chi tiết để đính kèm file ngay
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
function showModal(modal, onClose) {
  modal.classList.add('show');
  modal.onclick = (e) => { if (e.target === modal) closeModal(modal, onClose); };
}
function closeModal(modal, onClose) {
  modal.classList.remove('show');
  if (onClose) onClose();
}
