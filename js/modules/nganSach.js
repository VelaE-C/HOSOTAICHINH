// ============================================================
// nganSach.js — Chỉ QLCP&HĐ / PTGD / TGD / Admin thấy tab này (đã chặn ở shell.js
// theo TAB_BY_ROLE, và ở tầng RLS database — module này không cần tự kiểm tra quyền).
// ============================================================
import { supabase } from '../core/config.js';
import { fmt, toast, loading, budgetColor } from '../core/utils.js';

let VIEW_PROJECT = 'ALL';

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải…</div>`;

  const { data: projects } = await supabase.from('projects').select('id, code, name').order('code');
  if (!projects || projects.length === 0) {
    container.innerHTML = `<div class="empty-note">Chưa có dự án nào trong hệ thống.</div>`;
    return;
  }

  let q = supabase.from('v_budget_summary').select('*');
  if (VIEW_PROJECT !== 'ALL') q = q.eq('project_id', VIEW_PROJECT);
  const { data: rows, error } = await q;

  if (error) {
    container.innerHTML = `<div class="empty-note">⚠️ Không có quyền xem, hoặc lỗi: ${error.message}</div>`;
    return;
  }

  // Gộp theo mã ngân sách khi ở chế độ "Tất cả dự án"
  const merged = {};
  (rows || []).forEach((r) => {
    if (!merged[r.budget_code]) merged[r.budget_code] = { budget_code: r.budget_code, budget_name: r.budget_name, group_code: r.group_code, allocated_value: 0, committed: 0, actual_spend: 0 };
    merged[r.budget_code].allocated_value += Number(r.allocated_value || 0);
    merged[r.budget_code].committed += Number(r.committed || 0);
    merged[r.budget_code].actual_spend += Number(r.actual_spend || 0);
  });
  const list = Object.values(merged);

  const { data: revisions } = await supabase
    .from('budget_revisions')
    .select('revision_code, effective_date, project_id')
    .in('project_id', VIEW_PROJECT === 'ALL' ? projects.map((p) => p.id) : [VIEW_PROJECT])
    .order('effective_date', { ascending: false });

  container.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:12px">
      <select class="btn btn-secondary" id="projFilter">
        <option value="ALL" ${VIEW_PROJECT === 'ALL' ? 'selected' : ''}>Tất cả dự án</option>
        ${projects.map((p) => `<option value="${p.id}" ${VIEW_PROJECT === p.id ? 'selected' : ''}>${p.code} — ${p.name}</option>`).join('')}
      </select>
    </div>
    <div class="card"><div class="card-title">Phiên bản ngân sách</div>
      <div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap">
        ${revisions && revisions.length ? [...new Set(revisions.map((r) => r.revision_code))].map((rc) => `<span class="badge info">${rc}</span>`).join('') : '<span class="badge idle">Chưa có phiên bản nào</span>'}
        <button class="btn btn-sm btn-secondary" id="btnNewRevision" style="margin-left:auto" ${VIEW_PROJECT === 'ALL' ? 'disabled title="Chọn 1 dự án cụ thể để tạo phiên bản mới"' : ''}>+ Tạo phiên bản mới</button>
      </div></div>
    <div class="card" style="padding:0;overflow:hidden"><table><thead><tr><th>Mã ngân sách</th><th>Nhóm</th><th>Phân bổ</th><th>Cam kết</th><th>Thực chi</th><th style="width:150px">Tỉ lệ cam kết</th></tr></thead><tbody>
    ${list.length ? list.map((r) => {
      const pct = r.allocated_value ? (r.committed / r.allocated_value * 100) : 0;
      return `<tr><td><span class="code-chip">${r.budget_code}</span><div style="font-size:11px;color:var(--gray5);margin-top:3px">${r.budget_name}</div></td>
      <td style="font-size:12px;color:var(--gray5)">${r.group_code}</td><td class="mono">${fmt(r.allocated_value)}</td><td class="mono">${fmt(r.committed)}</td><td class="mono">${fmt(r.actual_spend)}</td>
      <td><div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, pct)}%;background:${budgetColor(pct)}"></div></div></td></tr>`;
    }).join('') : `<tr><td colspan="6" style="text-align:center;color:var(--gray4);padding:20px">Chưa có phiên bản ngân sách nào cho phạm vi này</td></tr>`}
    </tbody></table></div>`;

  container.querySelector('#projFilter').addEventListener('change', (e) => {
    VIEW_PROJECT = e.target.value;
    render(container, user);
  });
  container.querySelector('#btnNewRevision')?.addEventListener('click', () => openCreateRevisionModal(VIEW_PROJECT, user, () => render(container, user)));
}

async function openCreateRevisionModal(projectId, user, onClose) {
  const modal = ensureModal();
  const { data: categories } = await supabase.from('budget_categories').select('code, name, group_code').order('code');

  // Gợi ý sẵn giá trị theo phiên bản mới nhất hiện có, để chỉnh thay vì gõ lại từ đầu
  const { data: latestRev } = await supabase.from('budget_revisions').select('id, revision_code').eq('project_id', projectId).order('effective_date', { ascending: false }).limit(1).maybeSingle();
  let latestLines = {};
  if (latestRev) {
    const { data: lines } = await supabase.from('budget_revision_lines').select('budget_code, allocated_value').eq('revision_id', latestRev.id);
    (lines || []).forEach((l) => (latestLines[l.budget_code] = l.allocated_value));
  }
  const nextCode = latestRev ? 'R' + String(Number(latestRev.revision_code.replace('R', '')) + 1).padStart(2, '0') : 'R00';

  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Tạo phiên bản ngân sách mới</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="margin-bottom:13px"><label class="form-label">Mã phiên bản</label><input type="text" id="fCode" class="form-input" value="${nextCode}"></div>
      <div style="margin-bottom:13px"><label class="form-label">Ngày hiệu lực</label><input type="date" id="fDate" class="form-input" value="${new Date().toISOString().slice(0, 10)}"></div>
      <div style="margin-bottom:13px"><label class="form-label">Ghi chú</label><input type="text" id="fNote" class="form-input" placeholder="VD: Điều chỉnh do trượt giá vật liệu"></div>
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Giá trị theo mã ngân sách</div>
      <div class="card" style="padding:12px">
        ${(categories || []).map((c) => `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <span class="code-chip" style="width:110px;flex:none">${c.code}</span>
          <input type="number" class="form-input budget-line-input" data-code="${c.code}" value="${latestLines[c.code] || 0}" style="flex:1">
        </div>`).join('')}
      </div>
    </div>
    <div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">Ban hành phiên bản</button></div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const revision_code = modal.querySelector('#fCode').value.trim();
    const effective_date = modal.querySelector('#fDate').value;
    const note = modal.querySelector('#fNote').value.trim();
    if (!revision_code || !effective_date) return toast('Điền đủ mã phiên bản và ngày hiệu lực', 'error');

    loading(true);
    const { data: rev, error } = await supabase.from('budget_revisions').insert({ project_id: projectId, revision_code, effective_date, note, created_by: user.id }).select('id').single();
    if (error) return toast('Lỗi tạo phiên bản: ' + error.message, 'error');

    const lines = [...modal.querySelectorAll('.budget-line-input')].map((el) => ({ revision_id: rev.id, budget_code: el.dataset.code, allocated_value: Number(el.value) || 0 }));
    const { error: lineErr } = await supabase.from('budget_revision_lines').insert(lines);
    if (lineErr) return toast('Đã tạo phiên bản nhưng lỗi lưu giá trị: ' + lineErr.message, 'error');

    toast('Đã ban hành phiên bản ngân sách mới', 'success');
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
