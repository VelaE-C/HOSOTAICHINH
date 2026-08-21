// ============================================================
// dashboard.js — Tổng quan: Ngân sách/Cam kết/Thực chi, HĐ CĐT vs ngân sách,
// danh sách hồ sơ vượt (Case 1/2), danh sách đơn vị đã ký hợp đồng.
// Toàn bộ dữ liệu lấy thật từ Supabase — RLS tự lọc đúng phạm vi theo vai trò
// đang đăng nhập, module này không cần tự kiểm tra quyền.
// ============================================================
import { supabase } from '../core/config.js';
import { fmt, tyi, budgetColor } from '../core/utils.js';

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải dữ liệu…</div>`;

  const [{ data: projects }, { data: budgetRows }, { data: revenueRows }, { data: flagged }, { data: contracts }, { data: bills }] =
    await Promise.all([
      supabase.from('projects').select('id, code, name').order('code'),
      supabase.from('v_budget_summary').select('*'),
      supabase.from('revenue_contracts').select('project_id, investor, value'),
      supabase.from('v_flagged_documents').select('*'),
      supabase.from('contracts').select('id, doc_number, value, project_id, partners(name)'),
      supabase.from('bills').select('contract_id, val_d'),
    ]);

  if (!projects || projects.length === 0) {
    container.innerHTML = `<div class="empty-note">Chưa có dự án nào trong hệ thống, hoặc bạn chưa được phân công dự án nào.</div>`;
    return;
  }

  // Tổng hợp ngân sách 3 lớp (RLS đã tự giới hạn: chỉ QLCP&HĐ/PTGD/TGD/Admin mới có dữ liệu ở đây)
  const totBudget = (budgetRows || []).reduce((s, r) => s + Number(r.allocated_value || 0), 0);
  const totCommit = (budgetRows || []).reduce((s, r) => s + Number(r.committed || 0), 0);
  const totActual = (budgetRows || []).reduce((s, r) => s + Number(r.actual_spend || 0), 0);
  const totRevenue = (revenueRows || []).reduce((s, r) => s + Number(r.value || 0), 0);
  const delta = totRevenue - totBudget;

  // Danh sách đơn vị đã ký hợp đồng — so với lũy kế bill (Case 1 ngay trong tầm mắt)
  const lũyKeByContract = {};
  (bills || []).forEach((b) => {
    if (!b.contract_id) return;
    lũyKeByContract[b.contract_id] = Math.max(lũyKeByContract[b.contract_id] || 0, Number(b.val_d || 0));
  });
  const unitRows = (contracts || []).map((c) => {
    const lũyKe = lũyKeByContract[c.id] || 0;
    return { partner: c.partners?.name || '—', docNumber: c.doc_number, value: c.value, lũyKe, left: c.value - lũyKe, over: lũyKe > c.value };
  });

  container.innerHTML = `
    ${budgetRows && budgetRows.length ? `
    <div class="card"><div class="stat-row" style="grid-template-columns:repeat(3,1fr)">
      <div><div class="card-sub" style="margin:0">Ngân sách phân bổ</div><div class="stat-num">${tyi(totBudget)}</div></div>
      <div><div class="card-sub" style="margin:0">Cam kết (Hợp đồng)</div><div class="stat-num" style="color:var(--blue)">${tyi(totCommit)}</div><div class="stat-delta">${totBudget ? (totCommit / totBudget * 100).toFixed(0) : 0}% ngân sách</div></div>
      <div><div class="card-sub" style="margin:0">Thực chi (Bill đã duyệt)</div><div class="stat-num teal">${tyi(totActual)}</div><div class="stat-delta">${totCommit ? (totActual / totCommit * 100).toFixed(0) : 0}% cam kết</div></div>
    </div></div>

    <div class="card"><div class="card-title">Giá trị hợp đồng CĐT so với Ngân sách phân bổ</div>
      <div class="card-sub">Ngân sách phân bổ là giá trị HĐ CĐT sau khi QLCP&HĐ đã bóc tách sẵn phần lợi nhuận</div>
      <div class="stat-row" style="grid-template-columns:repeat(3,1fr)">
        <div><div class="card-sub" style="margin:0">Giá trị HĐ CĐT</div><div class="stat-num">${tyi(totRevenue)}</div></div>
        <div><div class="card-sub" style="margin:0">Ngân sách phân bổ</div><div class="stat-num">${tyi(totBudget)}</div></div>
        <div><div class="card-sub" style="margin:0">Lợi nhuận đã bóc tách</div><div class="stat-num" style="color:${delta >= 0 ? 'var(--green)' : 'var(--red)'}">${delta >= 0 ? '+' : ''}${tyi(delta)}</div></div>
      </div></div>` : `<div class="empty-note">Không có quyền xem số liệu ngân sách tổng hợp (chỉ QLCP&HĐ / PTGD / TGD mới xem được mục này).</div>`}

    ${flagged && flagged.length ? `
    <div class="card"><div class="card-title">⚠️ Hồ sơ đang có cảnh báo</div>
      <table><thead><tr><th>Loại</th><th>Số hồ sơ</th><th>Lý do</th></tr></thead><tbody>
      ${flagged.map((f) => `<tr><td>${f.doc_type === 'contract' ? 'Hợp đồng' : 'Bill'}</td><td class="mono">${f.doc_number}</td><td><span class="badge progress">${f.flag_reason}</span></td></tr>`).join('')}
      </tbody></table></div>` : ''}

    <div class="card"><div class="card-title">Danh sách đơn vị đã ký hợp đồng</div>
      <div class="card-sub">Giá trị hợp đồng so với giá trị lũy kế đã bill</div>
      <table><thead><tr><th>Đối tác</th><th>Số hợp đồng</th><th>Giá trị HĐ</th><th>GT lũy kế bill</th><th>Còn lại</th></tr></thead><tbody>
      ${unitRows.length ? unitRows.map((u) => `<tr><td>${u.partner}</td><td class="mono">${u.docNumber}</td><td class="mono">${fmt(u.value)}</td>
      <td class="mono">${fmt(u.lũyKe)}</td><td class="mono" style="font-weight:700;color:${u.over ? 'var(--red)' : 'var(--green)'}">${fmt(u.left)}${u.over ? ' ⚠️' : ''}</td></tr>`).join('') :
      `<tr><td colspan="5" style="text-align:center;color:var(--gray4);padding:20px">Chưa có hợp đồng nào</td></tr>`}
      </tbody></table></div>
  `;
}
