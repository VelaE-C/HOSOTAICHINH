// ============================================================
// thucthu.js — Sản lượng từ Chủ đầu tư (CĐT) đã được xác nhận
//
// Ghi nhận SẢN LƯỢNG CĐT đã xác nhận theo từng đợt claim, dựng đúng theo mẫu giấy
// "BẢNG TÓM TẮT THANH TOÁN / SUMMARY OF PAYMENT" mà CĐT đang dùng.
//
// KHÔNG phải tiền thực thu: tiền về còn có tạm ứng, giữ lại bảo hành, trả chậm —
// lệch cả thời điểm lẫn giá trị. KHÔNG qua luồng phê duyệt: đây là số liệu ghi nhận
// thực tế, không phải đề nghị chi tiền. Bù lại, mỗi dòng nên có chứng từ đính kèm,
// và database tự ghi ai nhập / ai sửa / lúc nào (trigger trg_stamp_progress_claim)
// — giao diện KHÔNG gửi 2 trường đó lên.
//
// Quyền: chỉ QLCPHD_CV / QLCPHD_TP / Admin nhập và sửa; xóa thì chỉ QLCPHD_TP và
// Admin. Luật thật nằm ở RLS bảng owner_progress_claims — phần ẩn/hiện nút dưới đây
// chỉ để đỡ bấm nhầm, KHÔNG phải cơ chế bảo vệ.
//
// ============================================================
// 14 DÒNG CỦA PHIẾU — CHỈ 6 DÒNG PHẢI NHẬP TAY
// ------------------------------------------------------------
//   NHẬP:  (2) thi công kỳ này · (5) tạm ứng · (7) hoàn tạm ứng
//          (8) phạt/khấu trừ   · (11) giữ do NCR · ngày CĐT xác nhận
//   TÍNH:  (1) (3) (4) (6) (9) (10) (12) (13)
//
// ⚠️ QUY ƯỚC DẤU: phiếu giấy ghi khoản trừ trong ngoặc — (427.744.900).
//   Hệ thống LƯU SỐ DƯƠNG ở 4 ô khấu trừ, phần mềm tự trừ. Database có ràng buộc
//   CHECK chặn số âm. Đây là bài học rút từ ô J của bill: để người dùng tự quyết
//   dấu âm thì sớm muộn cũng có người nhập nhầm, mà sai thì không ai nhìn ra.
//
// ⚠️ CÔNG THỨC THUẾ KHÁC CHỮ IN TRÊN PHIẾU:
//   Phiếu ghi "(10) = [(1)+(8)] x 8%", nhưng số thật 184.662.307 chỉ khớp khi lấy
//   (2)+(8) — giá trị thi công kỳ này, không phải tổng cộng dồn. Đã đối chiếu:
//       (2)+(8) x8% = 184.662.307  ✓ khớp phiếu
//       (4)+(8) x8% = 161.849.245
//       (9)     x8% = 127.629.653
//   Code làm theo SỐ THẬT, và đó cũng đúng bản chất: giữ lại bảo hành và hoàn tạm
//   ứng là chuyện dòng tiền, không làm giảm doanh thu nên không trừ trước khi
//   tính thuế. Ô công thức trên mẫu Excel của CĐT nhiều khả năng ghi nhầm.
// ============================================================
import { supabase } from '../core/config.js';
import { fmt, fmtDate, fmtDateTime, toast, loading, wireMoneyInputs, parseMoneyInput, formatMoneyInput, pushModalHistory, popModalHistory, IS_MOBILE } from '../core/utils.js';
import { renderAttachments, renderFilePicker, uploadStagedFiles } from '../core/attachments.js';
import { exportListExcel } from './bctcExport.js';

const OWNER_TYPE = 'progress_claim'; // phải khớp đúng nhánh đã thêm trong can_see_document()
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

let VIEW_PROJECT = 'ALL';

const canEdit = (user) => (user.roles || []).some((r) => ['QLCPHD_CV', 'QLCPHD_TP', 'Admin'].includes(r));
const canDelete = (user) => (user.roles || []).some((r) => ['QLCPHD_TP', 'Admin'].includes(r));

// Kỳ lưu dạng ngày 01 của tháng -> hiện "09/2026"
const fmtPeriod = (d) => (d ? `${String(new Date(d).getMonth() + 1).padStart(2, '0')}/${new Date(d).getFullYear()}` : '—');
// <input type="month"> cần "2026-09"
const toMonthInput = (d) => (d ? new Date(d).toISOString().slice(0, 7) : '');
const fromMonthInput = (v) => (v ? `${v}-01` : null);

const num = (v) => Number(v || 0);

// ============================================================
// TÍNH 1 ĐỢT CLAIM — đúng thứ tự dòng của phiếu giấy
// Mọi ô khấu trừ nhận SỐ DƯƠNG, hàm này tự trừ.
// ============================================================
export function calcClaim(r) {
  const B2 = num(r.amount_before_vat);                       // (2)  thi công kỳ này
  const rate = r.retention_rate == null ? 10 : Number(r.retention_rate);
  const vat = r.vat_rate == null ? 8 : Number(r.vat_rate);
  const wrate = r.warranty_rate == null ? 0 : Number(r.warranty_rate);
  // (3) và (3b) để trống thì tính theo tỉ lệ; điền thì dùng số CĐT đã chốt
  const B3 = r.retention_period == null || r.retention_period === '' ? Math.round((B2 * rate) / 100) : num(r.retention_period);
  // ⭐ BẢO HÀNH là khoản giữ THỨ HAI, tách riêng khỏi giữ lại (xác nhận 02/10).
  // Hợp đồng kiểu SOLERA giữ 5% đến bàn giao + 5% qua hết bảo hành -> dòng (4)
  // phải trừ CẢ HAI. Hợp đồng chỉ có một khoản thì warranty_rate = 0, ra y như cũ.
  const B3b = r.warranty_period == null || r.warranty_period === '' ? Math.round((B2 * wrate) / 100) : num(r.warranty_period);
  const B4 = B2 - B3 - B3b;                                  // (4) = (2) + (3) + (3b)
  const B7 = num(r.advance_recovery);                        // (7)  hoàn tạm ứng
  const B8 = num(r.deductions);                              // (8)  phạt / khấu trừ
  const B11 = num(r.ncr_withheld);                           // (11) giữ do NCR
  const B9 = B4 - B7 - B8;                                   // (9)  chưa VAT
  const B10 = Math.round(((B2 - B8) * vat) / 100);           // (10) xem ghi chú đầu file
  const B12 = B9 + B10 - B11;                                // (12) = (14) đề nghị TT
  return { B2, B3, B3b, B4, B7, B8, B9, B10, B11, B12, rate, wrate, vat };
}

// ============================================================
// LŨY KẾ QUA CÁC ĐỢT của cùng một dự án
//   (1)  = tổng (2) của các đợt <= đợt này
//   (6)  = tổng tạm ứng (<= đợt này) − tổng đã hoàn của các đợt TRƯỚC
//   (13) = tổng tạm ứng + tổng (12) của các đợt <= đợt này
// ============================================================
export function calcCumulative(r, all) {
  const sib = (all || []).filter((x) => x.project_id === r.project_id && x.claim_no != null);
  const n = Number(r.claim_no);
  const upTo = sib.filter((x) => Number(x.claim_no) <= n);
  const before = sib.filter((x) => Number(x.claim_no) < n);

  const B1 = upTo.reduce((s, x) => s + num(x.amount_before_vat), 0);
  const advTotal = upTo.reduce((s, x) => s + num(x.advance_payment), 0);
  const recBefore = before.reduce((s, x) => s + num(x.advance_recovery), 0);
  const B6 = advTotal - recBefore;
  const B13 = advTotal + upTo.reduce((s, x) => s + calcClaim(x).B12, 0);
  return { B1, B6, B13, advTotal };
}

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải…</div>`;

  const [{ data: projects }, { data: rows, error }] = await Promise.all([
    supabase.from('projects').select('id, code, name').order('code'),
    supabase
      .from('owner_progress_claims')
      .select('*, projects(code, name), creator:created_by(full_name), editor:updated_by(full_name)')
      .order('project_id')
      .order('claim_no'),
  ]);

  if (error) {
    container.innerHTML = `<div class="empty-note">⚠️ Không có quyền xem, hoặc lỗi: ${esc(error.message)}</div>`;
    return;
  }

  const all = rows || [];
  const list = VIEW_PROJECT === 'ALL' ? all : all.filter((r) => r.project_id === VIEW_PROJECT);
  const tongSanLuong = list.reduce((s, r) => s + num(r.amount_before_vat), 0);
  const tongDeNghi = list.reduce((s, r) => s + calcClaim(r).B12, 0);
  const editable = canEdit(user);

  container.innerHTML = `
    <div style="display:flex;${IS_MOBILE ? 'flex-direction:column;align-items:stretch' : 'justify-content:space-between;flex-wrap:wrap'};margin-bottom:12px;gap:10px">
      <select class="btn btn-secondary" id="projFilter" style="${IS_MOBILE ? 'width:100%;max-width:100%;box-sizing:border-box' : 'min-width:320px'}">
        <option value="ALL" ${VIEW_PROJECT === 'ALL' ? 'selected' : ''}>Tất cả dự án</option>
        ${(projects || []).map((p) => `<option value="${p.id}" ${VIEW_PROJECT === p.id ? 'selected' : ''}>${esc(p.code)} — ${esc(p.name)}</option>`).join('')}
      </select>
      <div style="display:flex;gap:8px;${IS_MOBILE ? 'flex-direction:column' : ''}">
        <button class="btn btn-secondary" id="btnExport">📊 Xuất Excel</button>
        ${editable ? `<button class="btn btn-primary" id="btnNew">+ Ghi nhận đợt claim</button>` : ''}
      </div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="stat-row" style="grid-template-columns:repeat(3,1fr)">
        <div><div class="card-sub" style="margin:0">Số đợt claim đã ghi nhận</div><div class="stat-num">${list.length}</div></div>
        <div><div class="card-sub" style="margin:0">Tổng sản lượng (trước thuế)</div><div class="stat-num teal">${fmt(tongSanLuong)} ₫</div></div>
        <div><div class="card-sub" style="margin:0">Tổng đề nghị thanh toán (có VAT)</div><div class="stat-num">${fmt(tongDeNghi)} ₫</div></div>
      </div>
    </div>

    ${!editable ? `<div style="font-size:11.5px;color:var(--gray4);margin-bottom:8px">🔒 Chỉ phòng QLCP&HĐ nhập được số liệu ở tab này — bạn chỉ xem.</div>` : ''}

    <div class="card" style="padding:0;overflow:hidden">
      <div style="overflow-x:auto"><table><thead><tr>
        ${IS_MOBILE
          ? '<th>Dự án</th><th>Đợt</th><th style="text-align:right">Đề nghị TT</th>'
          : `<th>Dự án</th><th>Đợt</th><th>Kỳ</th><th>Hạng mục</th>
             <th style="text-align:right">(2) Doanh thu kỳ này</th>
             <th style="text-align:right">(1) Lũy kế</th>
             <th style="text-align:right">% HĐ</th>
             <th style="text-align:right">(12) Đề nghị TT kỳ này</th>
             <th>Ngày XN</th><th>Người nhập</th>`}
      </tr></thead><tbody>
      ${list.length
        ? list
            .map((r) => {
              const c = calcClaim(r);
              const k = calcCumulative(r, all);
              const tran = num(r.contract_amount) + num(r.vo_amount);
              const pct = tran > 0 ? Math.round((k.B1 / tran) * 100) : null;
              if (IS_MOBILE) {
                return `<tr class="click" data-id="${r.id}" style="cursor:pointer">
                  <td><span class="code-chip">${esc(r.projects?.code || '—')}</span></td>
                  <td class="mono" style="font-weight:700">${r.claim_no}</td>
                  <td class="mono" style="text-align:right;font-weight:700">${fmt(c.B12)}</td></tr>`;
              }
              return `<tr class="click" data-id="${r.id}" style="cursor:pointer">
          <td><span class="code-chip" title="${esc(r.projects?.name)}">${esc(r.projects?.code || '—')}</span></td>
          <td class="mono" style="font-weight:700">${r.claim_no}</td>
          <td class="mono">${fmtPeriod(r.period_month)}</td>
          <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--gray6)" title="${esc(r.scope_summary)}">${esc(r.scope_summary || '—')}</td>
          <td class="mono" style="text-align:right;font-weight:700">${fmt(c.B2)}</td>
          <td class="mono" style="text-align:right;color:var(--gray6)">${fmt(k.B1)}</td>
          <td class="mono" style="text-align:right;color:var(--gray5)">${pct == null ? '—' : pct + '%'}</td>
          <td class="mono" style="text-align:right;font-weight:700;color:var(--green,#16A34A)">${fmt(c.B12)}</td>
          <td>${fmtDate(r.confirmed_date)}</td>
          <td style="font-size:11.5px;color:var(--gray5)">${esc(r.creator?.full_name || '—')}</td>
        </tr>`;
            })
            .join('')
        : `<tr><td colspan="${IS_MOBILE ? 3 : 10}" style="text-align:center;color:var(--gray4);padding:22px">Chưa ghi nhận đợt claim nào${VIEW_PROJECT !== 'ALL' ? ' cho dự án này' : ''}</td></tr>`}
      </tbody></table></div>
    </div>`;

  container.querySelector('#projFilter').addEventListener('change', (e) => {
    VIEW_PROJECT = e.target.value;
    render(container, user);
  });
  container.querySelector('#btnNew')?.addEventListener('click', () => openForm(null, projects, all, user, () => render(container, user)));
  container.querySelectorAll('[data-id]').forEach((tr) =>
    tr.addEventListener('click', () => {
      const rec = list.find((x) => x.id === tr.dataset.id);
      if (rec) openForm(rec, projects, all, user, () => render(container, user));
    }),
  );

  container.querySelector('#btnExport').addEventListener('click', () =>
    exportListExcel(
      {
        subtitle: 'SẢN LƯỢNG TỪ CHỦ ĐẦU TƯ ĐÃ XÁC NHẬN',
        note: VIEW_PROJECT === 'ALL' ? 'Tất cả dự án' : `Dự án: ${(projects || []).find((p) => p.id === VIEW_PROJECT)?.code || ''}`,
        columns: [
          { key: 'stt', header: 'STT', width: 6, center: true },
          { key: 'maduan', header: 'MÃ DỰ ÁN', width: 14, center: true },
          { key: 'kyclaim', header: 'KỲ CLAIM', width: 11, center: true },
          { key: 'tenduan', header: 'Tên dự án', width: 26 },
          { key: 'hangmuc', header: 'Hạng mục', width: 40 },
          { key: 'giatriHD', header: 'Giá trị Hợp đồng', width: 20, money: true },
          { key: 'dukienQT', header: 'Dự kiến Quyết toán', width: 20, money: true },
          { key: 'doanhthu', header: 'Doanh thu', width: 20, money: true },
          { key: 'vat', header: 'VAT', width: 18, money: true },
          { key: 'tamung', header: 'Tạm ứng', width: 18, money: true },
          { key: 'giulai', header: 'Giữ lại', width: 18, money: true },
          { key: 'baohanh', header: 'Bảo hành', width: 18, money: true },
          { key: 'khautru', header: 'Khấu trừ', width: 18, money: true },
          { key: 'thanhtoandot', header: 'Thanh toán đợt', width: 20, money: true },
          { key: 'luyke', header: 'Lũy kế sản lượng', width: 20, money: true },
          { key: 'hoantamung', header: 'Hoàn tạm ứng', width: 18, money: true },
          { key: 'ngayxn', header: 'Ngày CĐT xác nhận', width: 16, center: true },
          { key: 'ghichu', header: 'Ghi chú', width: 30 },
          { key: 'nguoinhap', header: 'Người nhập', width: 20 },
        ],
        rows: list.map((r, i) => {
          const c = calcClaim(r);
          const k = calcCumulative(r, all);
          return {
            stt: i + 1,
            maduan: r.projects?.code || '',
            kyclaim: r.claim_no,
            tenduan: r.projects?.name || '',
            hangmuc: r.scope_summary || '',
            giatriHD: num(r.contract_amount) + num(r.vo_amount),
            dukienQT: num(r.forecast_final),
            doanhthu: c.B2,
            vat: c.B10,
            tamung: num(r.advance_payment),
            giulai: c.B3,
            baohanh: c.B3b,
            khautru: c.B8,
            thanhtoandot: c.B12,
            luyke: k.B1,
            hoantamung: c.B7,
            ngayxn: fmtDate(r.confirmed_date),
            ghichu: r.note || '',
            nguoinhap: r.creator?.full_name || '',
          };
        }),
        fileBase: 'San_luong_CDT',
        sheetName: 'Sản lượng CĐT',
      },
      (msg) => toast(msg, 'error'),
    ),
  );
}

// ============================================================
// Dựng 1 dòng của bảng phiếu
//   id      — để cập nhật lại khi gõ (dòng tính tự động)
//   input   — true thì ô này nhập tay
//   negative— true thì hiện số đỏ kèm dấu trừ (khoản khấu trừ)
// ============================================================
function rowHtml({ no, label, sub, id, value = 0, input = false, negative = false, bold = false, highlight = false, editable = true }) {
  const bg = highlight ? 'background:#FEF9C3' : input ? '' : 'background:var(--gray1)';
  const cell = input
    ? `<input type="text" inputmode="numeric" id="${id}" class="form-input money-input" value="${formatMoneyInput(value)}"
         style="text-align:right;font-weight:600;padding:5px 8px" ${editable ? '' : 'disabled'}>`
    : `<span id="${id}" class="mono" style="font-weight:${bold ? 700 : 500};color:${negative ? 'var(--red)' : 'inherit'}">—</span>`;
  return `<tr style="${bg}">
    <td style="width:34px;text-align:center;color:var(--gray5);font-size:11.5px">${no || ''}</td>
    <td style="font-size:12.5px">${label}${sub ? `<div style="font-size:10.5px;color:var(--gray4);font-style:italic">${sub}</div>` : ''}</td>
    <td style="text-align:right;min-width:150px">${cell}</td>
  </tr>`;
}

// ============================================================
// Form ghi nhận / sửa 1 đợt claim — dựng theo đúng mẫu giấy
// rec = null -> tạo mới
// ============================================================
async function openForm(rec, projects, all, user, onClose) {
  const modal = ensureModal();
  const isNew = !rec;
  const editable = canEdit(user);

  // Đợt mới: kế thừa giá trị HĐ, VO và hai tỉ lệ từ đợt gần nhất của cùng dự án.
  // Nhập một lần ở đợt 01, các đợt sau khỏi gõ lại — và khỏi gõ lệch.
  function inheritFrom(projectId) {
    const sib = (all || []).filter((x) => x.project_id === projectId);
    if (!sib.length) return null;
    return sib.reduce((a, b) => (Number(b.claim_no) > Number(a.claim_no) ? b : a));
  }
  const firstProject = rec?.project_id || projects?.[0]?.id;
  const seed = isNew ? inheritFrom(firstProject) : null;
  const base = rec || {
    contract_amount: seed?.contract_amount ?? null,
    vo_amount: seed?.vo_amount ?? 0,
    scope_summary: seed?.scope_summary ?? '',
    forecast_final: seed?.forecast_final ?? 0,
    retention_rate: seed?.retention_rate ?? 10,
    warranty_rate: seed?.warranty_rate ?? 0,
    vat_rate: seed?.vat_rate ?? 8,
    claim_no: seed ? Number(seed.claim_no) + 1 : 1,
  };

  modal.innerHTML = `<div class="panel-box" style="max-width:820px">
    <div class="panel-header"><div>${isNew ? 'Ghi nhận đợt claim mới' : `Đợt ${rec.claim_no} — ${esc(rec.projects?.code || '')}`}</div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        ${!isNew ? `<button class="btn btn-sm btn-secondary" id="btnPrint">🖨️ In phiếu</button>` : ''}
        ${!isNew && canDelete(user) ? `<button class="btn btn-sm btn-danger" id="btnDelete">🗑️ Xóa</button>` : ''}
        <button class="panel-close" id="pClose">✕</button>
      </div></div>
    <div class="panel-body">
      <div style="font-size:12px;background:var(--lblue);color:#1D4ED8;padding:9px 12px;border-radius:7px;margin-bottom:14px;line-height:1.7">
        ℹ️ Dựng theo đúng mẫu <b>Bảng tóm tắt thanh toán</b> của CĐT. Chỉ <b>6 ô nền trắng</b> là nhập tay,
        các dòng nền xám hệ thống tự tính và tự cộng dồn qua các đợt.
        <div style="margin-top:5px">Các khoản <b>khấu trừ nhập SỐ DƯƠNG</b> — phần mềm tự trừ, đúng như phiếu giấy ghi trong ngoặc.</div>
      </div>

      <div style="margin-bottom:13px"><label class="form-label">Dự án *</label>
        <select id="fProject" class="form-input" ${isNew ? '' : 'disabled style="background:var(--gray1)"'}>
          ${(projects || []).map((p) => `<option value="${p.id}" ${base?.project_id === p.id || (isNew && p.id === firstProject) ? 'selected' : ''}>${esc(p.code)} — ${esc(p.name)}</option>`).join('')}
        </select>
        ${isNew ? '' : '<div style="font-size:11px;color:var(--gray4);margin-top:4px">Không đổi được dự án của đợt đã ghi nhận — nhập nhầm thì xóa dòng này rồi tạo lại.</div>'}</div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:16px">
        <div><label class="form-label">Đợt claim *</label>
          <input type="number" id="fClaim" class="form-input" min="1" value="${base?.claim_no ?? ''}">
          <div id="claimNote" style="font-size:11.5px;margin-top:4px"></div></div>
        <div><label class="form-label">Kỳ (tháng)</label>
          <input type="month" id="fPeriod" class="form-input" value="${toMonthInput(rec?.period_month)}"></div>
        <div><label class="form-label">Ngày CĐT xác nhận</label>
          <input type="date" id="fConfirmDate" class="form-input" value="${rec?.confirmed_date || ''}"></div>
      </div>

      <!-- ============ KHỐI A ============ -->
      <div style="margin-bottom:13px"><label class="form-label">Hạng mục</label>
        <input type="text" id="fScope" class="form-input" value="${esc(base?.scope_summary || '')}" placeholder="VD: Thi công kết cấu và hoàn thiện 34 căn liền kề">
        <div style="font-size:11px;color:var(--gray4);margin-top:4px">Chỉ là tên để nhận biết hợp đồng — mỗi dự án vẫn một chuỗi đợt claim duy nhất.</div></div>

      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">A · Giá trị hợp đồng (chưa VAT)</div>
      <div class="card" style="padding:0;overflow:hidden;margin-bottom:16px">
        <table style="width:100%"><tbody>
          ${rowHtml({ no: '1', label: 'Giá trị hợp đồng ban đầu', sub: 'Contract Amount', id: 'fContract', value: base?.contract_amount || 0, input: true, editable })}
          ${rowHtml({ no: '2', label: 'Giá trị các phát sinh', sub: 'VO Amount', id: 'fVo', value: base?.vo_amount || 0, input: true, editable })}
          ${rowHtml({ no: '', label: '<b>Giá trị hợp đồng sau điều chỉnh</b>', id: 'oTran', bold: true })}
          ${rowHtml({ no: '', label: 'Dự kiến Quyết toán', sub: 'Ước tính giá trị quyết toán cuối cùng — tự nhập', id: 'fForecast', value: base?.forecast_final || 0, input: true, editable })}
        </tbody></table>
      </div>
      <div style="font-size:11px;color:var(--gray4);margin:-10px 0 16px">
        Nhập một lần ở đợt 01 — các đợt sau tự lấy theo. Phiếu giữ nguyên số đã phát hành tại thời điểm claim, hợp đồng sau này điều chỉnh không làm đổi phiếu cũ.
      </div>

      <!-- ============ KHỐI B ============ -->
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">B · Giá trị thanh toán kỳ này</div>
      <div class="card" style="padding:0;overflow:hidden;margin-bottom:8px">
        <table style="width:100%"><tbody>
          ${rowHtml({ no: '1', label: 'Tổng giá trị thực hiện cộng dồn đến kỳ này', sub: 'Accumulated Workdone', id: 'oB1' })}
          ${rowHtml({ no: '2', label: '<b>Giá trị thi công kỳ này</b>', sub: 'Workdone this period', id: 'fB2', value: rec?.amount_before_vat || 0, input: true, editable })}
          ${rowHtml({ no: '3', label: 'Giá trị giữ lại kỳ này', sub: 'Retention this period', id: 'oB3', negative: true })}
          ${rowHtml({ no: '3b', label: 'Giá trị bảo hành giữ lại kỳ này', sub: 'Warranty retention — khoản giữ THỨ HAI, tách riêng', id: 'oB3b', negative: true })}
          ${rowHtml({ no: '4', label: 'Giá trị được thanh toán kỳ này <span style="color:var(--gray4)">(4) = (2) + (3) + (3b)</span>', id: 'oB4' })}
          ${rowHtml({ no: '5', label: 'Tạm ứng (nếu có)', sub: 'Advance payment', id: 'fB5', value: rec?.advance_payment || 0, input: true, editable })}
          ${rowHtml({ no: '6', label: 'Tạm ứng còn lại của đợt trước', sub: 'Remaining advance of previous payment', id: 'oB6' })}
          ${rowHtml({ no: '7', label: 'Hoàn trả tạm ứng đợt này', sub: 'Advance recovery this payment', id: 'fB7', value: rec?.advance_recovery || 0, input: true, editable })}
          ${rowHtml({ no: '8', label: 'Trừ các khoản phạt và khấu trừ', sub: 'Penalties and deductions', id: 'fB8', value: rec?.deductions || 0, input: true, editable })}
          ${rowHtml({ no: '9', label: '<b>Tổng giá trị được thanh toán kỳ này (chưa VAT)</b> <span style="color:var(--gray4)">(9) = (4) + (7) + (8)</span>', id: 'oB9', bold: true, highlight: true })}
          ${rowHtml({ no: '10', label: 'Thuế GTGT <span id="vatLabel" style="color:var(--gray4)"></span>', sub: 'VAT — tính trên (2) + (8), xem ghi chú bên dưới', id: 'oB10' })}
          ${rowHtml({ no: '11', label: 'Khoản tiền bị giữ do NCR', sub: 'Withholding money due to NCR', id: 'fB11', value: rec?.ncr_withheld || 0, input: true, editable })}
          ${rowHtml({ no: '12', label: '<b>Tổng giá trị được thanh toán kỳ này (bao gồm VAT)</b>', id: 'oB12', bold: true, highlight: true })}
          ${rowHtml({ no: '13', label: 'Tổng đã thanh toán cộng dồn đến kỳ này', sub: 'Bao gồm tạm ứng', id: 'oB13' })}
          ${rowHtml({ no: '14', label: '<b>GIÁ TRỊ ĐỀ NGHỊ THANH TOÁN KỲ NÀY</b>', id: 'oB14', bold: true })}
        </tbody></table>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:13px">
        <div><label class="form-label">Tỉ lệ giữ lại (%)</label>
          <input type="number" id="fRetRate" class="form-input" step="0.1" value="${base?.retention_rate ?? 10}"></div>
        <div><label class="form-label">Tỉ lệ bảo hành (%)</label>
          <input type="number" id="fWarRate" class="form-input" step="0.1" value="${base?.warranty_rate ?? 0}">
          <div style="font-size:10.5px;color:var(--gray4);margin-top:3px">Để 0 nếu hợp đồng chỉ có một khoản giữ lại</div></div>
        <div><label class="form-label">Thuế suất VAT (%)</label>
          <input type="number" id="fVat" class="form-input" step="0.1" value="${base?.vat_rate ?? 8}"></div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;margin-bottom:13px">
        <div><label class="form-label">Ghi đè dòng (3) Giữ lại</label>
          <input type="text" inputmode="numeric" id="fRetOverride" class="form-input money-input" value="${rec?.retention_period == null ? '' : formatMoneyInput(rec.retention_period)}" placeholder="Để trống = tính theo tỉ lệ"></div>
        <div><label class="form-label">Ghi đè dòng (3b) Bảo hành</label>
          <input type="text" inputmode="numeric" id="fWarOverride" class="form-input money-input" value="${rec?.warranty_period == null ? '' : formatMoneyInput(rec.warranty_period)}" placeholder="Để trống = tính theo tỉ lệ"></div>
      </div>

      <div style="font-size:11px;color:var(--gray5);background:#FFF7ED;border-radius:7px;padding:9px 12px;margin-bottom:14px;line-height:1.7">
        ⚠️ <b>Về dòng (10):</b> mẫu giấy của CĐT in công thức <i>[(1) + (8)] × 8%</i>, nhưng số thật trên phiếu
        chỉ khớp khi lấy <b>(2) + (8)</b>. Hệ thống làm theo số thật — và đó cũng đúng bản chất, vì giữ lại bảo
        hành với hoàn tạm ứng là chuyện dòng tiền, không làm giảm doanh thu nên không trừ trước khi tính thuế.
      </div>

      <div style="margin-bottom:13px"><label class="form-label">Ghi chú</label>
        <textarea id="fNote" class="form-input" rows="2" placeholder="VD: Claim đợt 02 — CĐT xác nhận khối lượng phần thân">${esc(rec?.note || '')}</textarea></div>

      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Chứng từ đính kèm</div>
      <div class="card" id="attachArea" style="padding:12px 14px"></div>

      ${!isNew ? `<div style="font-size:11.5px;color:var(--gray4);margin-top:12px;line-height:1.7">
        Người nhập: <b>${esc(rec.creator?.full_name || '—')}</b> · ${fmtDateTime(rec.created_at)}
        ${rec.updated_by ? `<br>Sửa lần cuối: <b>${esc(rec.editor?.full_name || '—')}</b> · ${fmtDateTime(rec.updated_at)}` : ''}
      </div>` : ''}
    </div>
    ${editable ? `<div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">💾 ${isNew ? 'Lưu đợt claim' : 'Lưu thay đổi'}</button></div>` : ''}
  </div>`;

  showModal(modal, onClose);
  wireMoneyInputs(modal);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  // ---- gom dữ liệu đang gõ thành 1 bản ghi tạm để tính ----
  function readForm() {
    const ov = modal.querySelector('#fRetOverride').value.trim();
    const ow = modal.querySelector('#fWarOverride').value.trim();
    return {
      id: rec?.id,
      project_id: modal.querySelector('#fProject').value,
      claim_no: Number(modal.querySelector('#fClaim').value) || 0,
      contract_amount: parseMoneyInput(modal.querySelector('#fContract').value),
      vo_amount: parseMoneyInput(modal.querySelector('#fVo').value),
      amount_before_vat: parseMoneyInput(modal.querySelector('#fB2').value),
      advance_payment: parseMoneyInput(modal.querySelector('#fB5').value),
      advance_recovery: parseMoneyInput(modal.querySelector('#fB7').value),
      deductions: parseMoneyInput(modal.querySelector('#fB8').value),
      ncr_withheld: parseMoneyInput(modal.querySelector('#fB11').value),
      retention_rate: Number(modal.querySelector('#fRetRate').value),
      warranty_rate: Number(modal.querySelector('#fWarRate').value),
      vat_rate: Number(modal.querySelector('#fVat').value),
      retention_period: ov === '' ? null : parseMoneyInput(ov),
      warranty_period: ow === '' ? null : parseMoneyInput(ow),
      scope_summary: modal.querySelector('#fScope').value.trim() || null,
      forecast_final: parseMoneyInput(modal.querySelector('#fForecast').value) || null,
    };
  }

  // Tính lại cả bảng mỗi lần gõ. Các đợt khác của cùng dự án lấy từ `all`, riêng
  // đợt đang sửa thì thay bằng số đang gõ để lũy kế phản ánh ngay.
  function refresh() {
    const cur = readForm();
    const others = (all || []).filter((x) => x.id !== cur.id);
    const merged = [...others, cur];
    const c = calcClaim(cur);
    const k = calcCumulative(cur, merged);
    const tran = num(cur.contract_amount) + num(cur.vo_amount);

    const put = (id, v, dau) => {
      const el = modal.querySelector('#' + id);
      if (el) el.textContent = (dau && v !== 0 ? '−' : '') + fmt(Math.abs(v)) + ' ₫';
    };
    put('oTran', tran);
    put('oB1', k.B1);
    put('oB3', c.B3, true);
    put('oB3b', c.B3b, true);
    put('oB4', c.B4);
    put('oB6', k.B6);
    put('oB9', c.B9);
    put('oB10', c.B10);
    put('oB12', c.B12);
    put('oB13', k.B13);
    put('oB14', c.B12);
    const lbl = modal.querySelector('#vatLabel');
    if (lbl) lbl.textContent = `(${c.vat}%)`;
  }
  modal.addEventListener('input', refresh);
  modal.addEventListener('change', refresh);
  refresh();

  // Soi trùng đợt NGAY LÚC GÕ — database đã chặn bằng ràng buộc duy nhất, nhưng để
  // người dùng nhập xong cả form rồi mới báo lỗi thì quá muộn.
  let claimTimer = null;
  async function checkClaimDup() {
    const note = modal.querySelector('#claimNote');
    const projectId = modal.querySelector('#fProject').value;
    const claimNo = Number(modal.querySelector('#fClaim').value);
    if (!projectId || !claimNo) return (note.innerHTML = '');
    if (!isNew && claimNo === rec.claim_no) return (note.innerHTML = '');
    const { data } = await supabase.from('owner_progress_claims').select('id').eq('project_id', projectId).eq('claim_no', claimNo).limit(1);
    note.innerHTML = data && data.length
      ? `<span style="color:var(--red);font-weight:600">✕ Đợt ${claimNo} của dự án này đã ghi nhận rồi.</span>`
      : `<span style="color:var(--green,#16A34A)">✓ Đợt này chưa có.</span>`;
  }
  modal.querySelector('#fClaim').addEventListener('input', () => {
    clearTimeout(claimTimer);
    claimTimer = setTimeout(checkClaimDup, 350);
  });

  // Đổi dự án khi đang tạo mới -> kế thừa lại giá trị HĐ và số đợt tiếp theo
  modal.querySelector('#fProject').addEventListener('change', (e) => {
    if (!isNew) return;
    const s = inheritFrom(e.target.value);
    modal.querySelector('#fContract').value = formatMoneyInput(s?.contract_amount || 0);
    modal.querySelector('#fVo').value = formatMoneyInput(s?.vo_amount || 0);
    modal.querySelector('#fScope').value = s?.scope_summary || '';
    modal.querySelector('#fForecast').value = formatMoneyInput(s?.forecast_final || 0);
    modal.querySelector('#fRetRate').value = s?.retention_rate ?? 10;
    modal.querySelector('#fWarRate').value = s?.warranty_rate ?? 0;
    modal.querySelector('#fVat').value = s?.vat_rate ?? 8;
    modal.querySelector('#fClaim').value = s ? Number(s.claim_no) + 1 : 1;
    refresh();
    checkClaimDup();
  });

  // Đính kèm: dòng ĐÃ có thì gắn thẳng; dòng MỚI chưa có id nên chọn tạm, lưu xong mới tải lên
  let filePicker = null;
  if (isNew) {
    filePicker = renderFilePicker(modal.querySelector('#attachArea'));
  } else {
    renderAttachments(modal.querySelector('#attachArea'), OWNER_TYPE, rec.id, user.id, editable, false, 0);
  }

  modal.querySelector('#btnPrint')?.addEventListener('click', () => openPrintClaim(rec, all));

  modal.querySelector('#btnDelete')?.addEventListener('click', async () => {
    if (!confirm(`Xóa đợt claim ${rec.claim_no} của dự án ${rec.projects?.code || ''}?\n\nLũy kế của các đợt SAU sẽ tính lại theo. Dữ liệu mất hẳn, không hoàn tác được.`)) return;
    loading(true);
    const { error } = await supabase.from('owner_progress_claims').delete().eq('id', rec.id);
    if (error) return toast('Lỗi xóa: ' + error.message, 'error');
    toast('Đã xóa đợt claim', 'success');
    closeModal(modal, onClose);
  });

  modal.querySelector('#btnSave')?.addEventListener('click', async () => {
    const f = readForm();
    const period_month = fromMonthInput(modal.querySelector('#fPeriod').value);
    const confirmed_date = modal.querySelector('#fConfirmDate').value || null;
    const note = modal.querySelector('#fNote').value.trim() || null;

    if (!f.project_id || !f.claim_no) return toast('Chọn Dự án và điền Đợt claim', 'error');
    if (!f.amount_before_vat) return toast('Điền dòng (2) Giá trị thi công kỳ này', 'error');
    if (!f.contract_amount) return toast('Điền Giá trị hợp đồng ban đầu ở khối A', 'error');

    // Chặn ngay ở giao diện cho dễ hiểu — database cũng có ràng buộc CHECK chặn lần nữa
    for (const [id, ten] of [['fB7', '(7) Hoàn trả tạm ứng'], ['fB8', '(8) Trừ phạt và khấu trừ'], ['fB11', '(11) Tiền giữ do NCR'], ['fRetOverride', 'Ghi đè dòng (3)'], ['fWarOverride', 'Ghi đè dòng (3b)']]) {
      const v = parseMoneyInput(modal.querySelector('#' + id).value);
      if (v < 0) return toast(`Ô ${ten} nhập SỐ DƯƠNG — phần mềm tự trừ. Phiếu giấy ghi trong ngoặc nhưng ở đây không gõ dấu âm.`, 'error');
    }

    loading(true);
    // CỐ Ý không gửi created_by/updated_by — trigger bên database tự ghi, không ai giả được
    const payload = {
      project_id: f.project_id,
      claim_no: f.claim_no,
      period_month,
      confirmed_date,
      note,
      contract_amount: f.contract_amount,
      vo_amount: f.vo_amount,
      amount_before_vat: f.amount_before_vat,
      advance_payment: f.advance_payment,
      advance_recovery: f.advance_recovery,
      deductions: f.deductions,
      ncr_withheld: f.ncr_withheld,
      retention_rate: f.retention_rate,
      retention_period: f.retention_period,
      warranty_rate: f.warranty_rate,
      warranty_period: f.warranty_period,
      scope_summary: f.scope_summary,
      forecast_final: f.forecast_final,
      vat_rate: f.vat_rate,
    };

    if (isNew) {
      const { data: created, error } = await supabase.from('owner_progress_claims').insert(payload).select('id').single();
      if (error) {
        if (error.message.includes('project_claim_unique') || error.message.includes('duplicate key')) {
          return toast(`Đợt ${f.claim_no} của dự án này đã được ghi nhận rồi — mở dòng đó ra sửa, đừng tạo trùng.`, 'error');
        }
        if (error.message.includes('opc_khau_tru_khong_am')) {
          return toast('Các ô khấu trừ phải là số dương — phần mềm tự trừ.', 'error');
        }
        return toast('Lỗi lưu: ' + error.message, 'error');
      }
      await uploadStagedFiles(filePicker.getFiles(), OWNER_TYPE, created.id, user.id);
      toast('Đã ghi nhận đợt claim', 'success');
    } else {
      const { error } = await supabase.from('owner_progress_claims').update(payload).eq('id', rec.id);
      if (error) {
        if (error.message.includes('project_claim_unique') || error.message.includes('duplicate key')) {
          return toast(`Đợt ${f.claim_no} của dự án này đã có dòng khác dùng rồi.`, 'error');
        }
        if (error.message.includes('opc_khau_tru_khong_am')) {
          return toast('Các ô khấu trừ phải là số dương — phần mềm tự trừ.', 'error');
        }
        return toast('Lỗi lưu: ' + error.message, 'error');
      }
      toast('Đã lưu thay đổi', 'success');
    }
    closeModal(modal, onClose);
  });
}

// ============================================================
// In phiếu để kẹp hồ sơ — dùng chức năng In của trình duyệt rồi chọn
// "Lưu thành PDF". Cố ý KHÔNG dùng thư viện tạo PDF: các thư viện đó hay
// mất dấu tiếng Việt nếu không nhúng font riêng rất phức tạp.
// ============================================================
function openPrintClaim(r, all) {
  const c = calcClaim(r);
  const k = calcCumulative(r, all);
  const tran = num(r.contract_amount) + num(r.vo_amount);
  const m = (v) => fmt(Math.abs(v));
  const neg = (v) => (v ? `<span style="color:#C00">(${fmt(Math.abs(v))})</span>` : '—');
  const vnDate = (d) => (d ? new Date(d).toLocaleDateString('vi-VN') : '—');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Claim đợt ${r.claim_no} — ${esc(r.projects?.code || '')}</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:12.5px;padding:24px;color:#111}
      table{width:100%;border-collapse:collapse;margin-bottom:10px}
      td,th{border:1px solid #333;padding:5px 9px;vertical-align:top}
      th{background:#f0ece3}
      .title{font-size:16px;font-weight:700;text-align:center;padding:10px}
      .label{font-weight:600;width:200px;background:#f7f5f0}
      .no{width:30px;text-align:center;color:#555}
      .num{text-align:right;font-family:'Courier New',monospace}
      .sub{font-size:10px;color:#666;font-style:italic}
      .hl{background:#FEF9C3;font-weight:700}
      .no-print{margin-bottom:14px}
      .logo{height:42px;margin-bottom:12px;display:block}
      @media print{.no-print{display:none}}
    </style></head>
    <body>
      <div class="no-print"><button onclick="window.print()" style="padding:8px 16px;font-size:13px">🖨️ In / Lưu thành PDF</button></div>
      <img class="logo" src="https://raw.githubusercontent.com/VelaE-C/HOSOTAICHINH/refs/heads/main/LOGO%20DUNG.JPEG.png" alt="VELA">
      <table>
        <tr><td colspan="3" class="title">BẢNG TÓM TẮT THANH TOÁN<div class="sub">SUMMARY OF PAYMENT</div></td></tr>
        <tr><td class="label">Dự án</td><td colspan="2">${esc(r.projects?.name || '—')}</td></tr>
        <tr><td class="label">Hạng mục</td><td colspan="2">${esc(r.scope_summary || '—')}</td></tr>
        <tr><td class="label">Đợt claim</td><td colspan="2">Đợt ${r.claim_no} — kỳ ${fmtPeriod(r.period_month)}</td></tr>
        <tr><td class="label">Ngày CĐT xác nhận</td><td colspan="2">${vnDate(r.confirmed_date)}</td></tr>
      </table>

      <table>
        <tr><th colspan="3">A · GIÁ TRỊ HỢP ĐỒNG (chưa VAT) <span class="sub">CONTRACT AMOUNT (Excluded VAT)</span></th></tr>
        <tr><td class="no">1</td><td>Giá trị hợp đồng ban đầu<div class="sub">Contract Amount</div></td><td class="num">${m(r.contract_amount)}</td></tr>
        <tr><td class="no">2</td><td>Giá trị các phát sinh<div class="sub">VO Amount</div></td><td class="num">${num(r.vo_amount) ? m(r.vo_amount) : '—'}</td></tr>
        <tr><td class="no"></td><td><b>Giá trị hợp đồng sau điều chỉnh</b></td><td class="num"><b>${m(tran)}</b></td></tr>
        <tr><td class="no"></td><td>Dự kiến Quyết toán</td><td class="num">${num(r.forecast_final) ? m(r.forecast_final) : '—'}</td></tr>
      </table>

      <table>
        <tr><th colspan="3">B · GIÁ TRỊ THANH TOÁN KỲ NÀY <span class="sub">PAYMENT AMOUNT THIS PERIOD</span></th></tr>
        <tr><td class="no">1</td><td>Tổng giá trị thực hiện cộng dồn đến kỳ này<div class="sub">Accumulated Workdone</div></td><td class="num">${m(k.B1)}</td></tr>
        <tr><td class="no">2</td><td><b>Giá trị thi công kỳ này</b><div class="sub">Workdone this period</div></td><td class="num"><b>${m(c.B2)}</b></td></tr>
        <tr><td class="no">3</td><td>Giá trị giữ lại kỳ này<div class="sub">Retention this period</div></td><td class="num">${neg(c.B3)}</td></tr>
        <tr><td class="no">3b</td><td>Giá trị bảo hành giữ lại kỳ này<div class="sub">Warranty retention</div></td><td class="num">${neg(c.B3b)}</td></tr>
        <tr><td class="no">4</td><td>Giá trị được thanh toán kỳ này (4) = (2) + (3) + (3b)</td><td class="num">${m(c.B4)}</td></tr>
        <tr><td class="no">5</td><td>Tạm ứng (nếu có)<div class="sub">Advance payment</div></td><td class="num">${num(r.advance_payment) ? m(r.advance_payment) : '—'}</td></tr>
        <tr><td class="no">6</td><td>Tạm ứng còn lại của đợt trước<div class="sub">Remaining advance of previous payment</div></td><td class="num">${m(k.B6)}</td></tr>
        <tr><td class="no">7</td><td>Hoàn trả tạm ứng đợt này<div class="sub">Advance recovery on this payment</div></td><td class="num">${neg(c.B7)}</td></tr>
        <tr><td class="no">8</td><td>Trừ các khoản phạt và khấu trừ<div class="sub">Penalties and deductions</div></td><td class="num">${neg(c.B8)}</td></tr>
        <tr class="hl"><td class="no">9</td><td>Tổng giá trị được thanh toán kỳ này (chưa VAT) (9) = (4) + (7) + (8)</td><td class="num">${m(c.B9)}</td></tr>
        <tr><td class="no">10</td><td>Thuế GTGT (${c.vat}%)<div class="sub">Tính trên (2) + (8)</div></td><td class="num">${m(c.B10)}</td></tr>
        <tr><td class="no">11</td><td>Khoản tiền bị giữ do NCR<div class="sub">Withholding money due to NCR</div></td><td class="num">${neg(c.B11)}</td></tr>
        <tr class="hl"><td class="no">12</td><td>Tổng giá trị được thanh toán kỳ này (bao gồm VAT)</td><td class="num">${m(c.B12)}</td></tr>
        <tr><td class="no">13</td><td>Tổng đã thanh toán cộng dồn đến kỳ này<div class="sub">Bao gồm tạm ứng</div></td><td class="num">${m(k.B13)}</td></tr>
        <tr class="hl"><td class="no">14</td><td>GIÁ TRỊ ĐỀ NGHỊ THANH TOÁN KỲ NÀY</td><td class="num">${m(c.B12)}</td></tr>
      </table>

      ${r.note ? `<table><tr><th>Ghi chú</th></tr><tr><td>${esc(r.note)}</td></tr></table>` : ''}

      <table><tr>
        <td style="text-align:center;height:90px"><b>CHỦ ĐẦU TƯ</b></td>
        <td style="text-align:center"><b>CÔNG TY CỔ PHẦN KỸ THUẬT XÂY DỰNG VELA</b></td>
      </tr></table>
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
function showModal(modal, onClose) {
  modal.classList.add('show');
  modal.scrollTop = 0;
  pushModalHistory();
}
function closeModal(modal, onClose) {
  modal.classList.remove('show');
  popModalHistory();
  if (onClose) onClose();
}
