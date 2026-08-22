// ============================================================
// hopdongdaura.js — Hợp đồng đầu ra (CĐT) làm nguồn Doanh thu.
// Chỉ nhập liệu, không qua luồng phê duyệt. Chỉ QLCP&HĐ/PTGD/TGD/Admin thấy tab này.
// ============================================================
import { supabase } from '../core/config.js';
import { fmt, fmtDateTime, toast, loading } from '../core/utils.js';

let VIEW_PROJECT = 'ALL';

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải…</div>`;

  const { data: projects } = await supabase.from('projects').select('id, code, name').order('code');
  if (!projects || projects.length === 0) {
    container.innerHTML = `<div class="empty-note">Chưa có dự án nào trong hệ thống.</div>`;
    return;
  }

  container.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:12px">
      <select class="btn btn-secondary" id="projFilter">
        <option value="ALL" ${VIEW_PROJECT === 'ALL' ? 'selected' : ''}>Tất cả dự án</option>
        ${projects.map((p) => `<option value="${p.id}" ${VIEW_PROJECT === p.id ? 'selected' : ''}>${p.code} — ${p.name}</option>`).join('')}
      </select>
    </div>
    <div class="warn-box" style="background:var(--lblue);border-color:#BFDBFE;color:#1D4ED8">ℹ️ <div>Tab này chỉ QLCP&HĐ nhìn thấy — nhập và lưu trữ giá trị hợp đồng ký với Chủ đầu tư (CĐT), không đi qua luồng phê duyệt. Dùng làm nguồn Doanh thu cho Dashboard và Báo cáo Lợi nhuận.</div></div>
    <div id="revenueArea"></div>
  `;

  container.querySelector('#projFilter').addEventListener('change', (e) => {
    VIEW_PROJECT = e.target.value;
    render(container, user);
  });

  const area = container.querySelector('#revenueArea');
  if (VIEW_PROJECT === 'ALL') {
    const { data: rows, error } = await supabase.from('revenue_contracts').select('*, projects(code, name)');
    if (error) {
      area.innerHTML = `<div class="empty-note">⚠️ Không có quyền xem, hoặc lỗi: ${error.message}</div>`;
      return;
    }
    area.innerHTML = `
      <div class="card" style="padding:0;overflow:hidden"><table><thead><tr><th>Dự án</th><th>Chủ đầu tư</th><th>Giá trị hợp đồng</th><th>Cập nhật lần cuối</th></tr></thead><tbody>
      ${rows && rows.length ? rows.map((r) => `<tr class="click" data-proj="${r.project_id}"><td><span class="badge idle">${r.projects?.code || '—'}</span></td><td>${r.investor}</td>
      <td class="mono" style="font-weight:700">${fmt(r.value)} ₫</td><td>${fmtDateTime(r.updated_at)}</td></tr>`).join('') :
      `<tr><td colspan="4" style="text-align:center;color:var(--gray4);padding:20px">Chưa có dự án nào nhập doanh thu</td></tr>`}
      </tbody></table></div>`;
    area.querySelectorAll('[data-proj]').forEach((r) =>
      r.addEventListener('click', () => {
        VIEW_PROJECT = r.dataset.proj;
        render(container, user);
      }),
    );
  } else {
    const { data: rev } = await supabase.from('revenue_contracts').select('*').eq('project_id', VIEW_PROJECT).maybeSingle();
    area.innerHTML = `
      <div class="card">
        ${rev ? `<div class="kv">
          <div class="k">Chủ đầu tư (CĐT)</div><div class="v" style="font-weight:600">${rev.investor}</div>
          <div class="k">Giá trị hợp đồng</div><div class="v mono" style="font-weight:700;font-size:16px">${fmt(rev.value)} ₫</div>
          <div class="k">Nội dung</div><div class="v">${rev.note || '—'}</div>
          <div class="k">Cập nhật lần cuối</div><div class="v">${fmtDateTime(rev.updated_at)}</div>
        </div>` : `<div class="empty-note">Dự án này chưa có dữ liệu hợp đồng CĐT — nhập bên dưới.</div>`}
        <button class="btn btn-secondary btn-sm" id="btnEdit">✏️ ${rev ? 'Cập nhật giá trị' : 'Nhập lần đầu'}</button>
      </div>`;
    area.querySelector('#btnEdit').addEventListener('click', () => openEditModal(VIEW_PROJECT, rev, user, () => render(container, user)));
  }
}

function openEditModal(projectId, rev, user, onClose) {
  const modal = ensureModal();
  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Hợp đồng đầu ra (CĐT)</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="margin-bottom:13px"><label class="form-label">Chủ đầu tư (CĐT)</label><input type="text" id="fInvestor" class="form-input" value="${rev?.investor || ''}"></div>
      <div style="margin-bottom:13px"><label class="form-label">Giá trị hợp đồng (₫)</label><input type="number" id="fValue" class="form-input" value="${rev?.value || ''}"></div>
      <div style="margin-bottom:13px"><label class="form-label">Nội dung</label><textarea id="fNote" class="form-input" rows="3">${rev?.note || ''}</textarea></div>
    </div>
    <div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">Lưu</button></div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const investor = modal.querySelector('#fInvestor').value.trim();
    const value = Number(modal.querySelector('#fValue').value);
    const note = modal.querySelector('#fNote').value.trim();
    if (!investor || !value) return toast('Điền đủ Chủ đầu tư và Giá trị', 'error');

    loading(true);
    const { error } = await supabase
      .from('revenue_contracts')
      .upsert({ project_id: projectId, investor, value, note, updated_by: user.id, updated_at: new Date().toISOString() }, { onConflict: 'project_id' });
    if (error) return toast('Lỗi lưu: ' + error.message, 'error');
    toast('Đã lưu hợp đồng đầu ra', 'success');
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
  modal.onclick = (e) => {
    if (!e.target.closest('.panel-box')) closeModal(modal, onClose);
  };
}
function closeModal(modal, onClose) {
  modal.classList.remove('show');
  if (onClose) onClose();
}
