// ============================================================
// duyet.js — Hộp thư chờ duyệt, gộp cả 4 loại hồ sơ, KHÔNG lọc theo dự án
// (đúng thiết kế: luôn hiện hết để không bỏ sót hồ sơ cần xử lý)
//
// ⚠️ SỬA 03/10/2026 — BCTC KHÔNG HIỆN TRONG HỘP THƯ
//   Bản cũ khai: const idsByType = { contract: [], bill: [], totrinh: [] };
//   rồi gom bằng  idsByType[m.document_type]?.push(...)
//   Không có khóa 'bctc' -> idsByType['bctc'] là undefined -> dấu ?. IM LẶNG
//   bỏ qua, không báo lỗi. Dòng chờ duyệt BCTC về tới trình duyệt rồi bị thả
//   xuống sàn. Database không sai: approval_assignments vẫn sinh dòng
//   document_type = 'bctc' (xem VELA_HSTC_fix_quyen_xem_BCTC_nguoi_duyet.sql).
//
//   Đây là kiểu lỗi nguy hiểm vì KHÔNG có thông báo lỗi nào — chỉ thiếu dữ liệu.
//   Thêm loại hồ sơ thứ 5 sau này thì phải khai ở ĐỦ 4 chỗ, đã đánh dấu
//   bằng  ⭐ THÊM LOẠI HỒ SƠ MỚI  bên dưới.
//
//   Thứ tự hiển thị theo yêu cầu: BCTC -> Tờ trình -> Hợp đồng -> Bill.
//   Khung nào không có hồ sơ thì ẨN luôn (bản cũ hiện cả khung rỗng; nay có 4
//   loại, để rỗng hết thì phải cuộn qua 3 khung trống mới tới cái cần xử lý).
// ============================================================
import { supabase } from '../core/config.js';
import { fmt, statusBadge, IS_MOBILE } from '../core/utils.js';
import { calcBill } from './bill.js'; // dùng chung ĐÚNG 1 công thức tính C/D/K với trang Bill — tránh lệch số giữa 2 màn hình

// ⭐ THÊM LOẠI HỒ SƠ MỚI (1/4) — tên file module để mở chi tiết khi bấm vào dòng
const MODULE_BY_TYPE = {
  bctc: 'bctc',
  totrinh: 'totrinh',
  contract: 'hopdong',
  bill: 'bill',
};

// ⭐ THÊM LOẠI HỒ SƠ MỚI (2/4) — thứ tự các khung từ trên xuống + tiêu đề khung
const SECTIONS = [
  { type: 'bctc', title: 'Báo cáo tài chính' },
  { type: 'totrinh', title: 'Tờ trình chủ trương' },
  { type: 'contract', title: 'Hợp đồng' },
  { type: 'bill', title: 'Bill thanh toán' },
];

// Bước 1-2: hạn 2 ngày (48h). Bước 3-4: hạn 1 ngày (24h) — khớp đúng quy tắc SLA đang dùng.
function isOverdue(m) {
  const slaHours = m.step_no <= 2 ? 48 : 24;
  return m.created_at && (Date.now() - new Date(m.created_at).getTime()) / 3600000 > slaHours;
}

const dmy = (d) => (d ? new Date(d).toLocaleDateString('vi-VN') : '—');

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải…</div>`;

  const { data: mine, error } = await supabase
    .from('approval_assignments')
    .select('document_type, document_id, step_no, role_type, created_at')
    .eq('user_id', user.id)
    .eq('status', 'pending');

  if (error) {
    container.innerHTML = `<div class="empty-note">⚠️ Lỗi tải dữ liệu: ${error.message}</div>`;
    return;
  }
  if (!mine || mine.length === 0) {
    container.innerHTML = `<div class="card empty-note"><div style="font-size:30px;margin-bottom:8px">🗂️</div><div style="font-weight:600;color:var(--gray7);margin-bottom:3px">Không có hồ sơ nào chờ bạn duyệt</div><div>Quay lại sau, hoặc kiểm tra bạn đã được gán đúng vai trò/dự án chưa.</div></div>`;
    return;
  }

  // Gom theo loại hồ sơ để truy vấn 1 lần cho mỗi bảng, đỡ gọi lẻ tẻ nhiều lần.
  // ⭐ THÊM LOẠI HỒ SƠ MỚI (3/4) — khai khóa ở đây, nếu không thì mất dữ liệu
  // trong im lặng (đúng cái lỗi BCTC đã mắc).
  const idsByType = { bctc: [], totrinh: [], contract: [], bill: [] };
  const lostTypes = new Set();
  mine.forEach((m) => {
    if (idsByType[m.document_type]) idsByType[m.document_type].push(m.document_id);
    else lostTypes.add(m.document_type); // kêu lên thay vì bỏ qua im lặng
  });
  if (lostTypes.size) {
    console.error(
      `[duyet.js] Có dòng chờ duyệt thuộc loại hồ sơ chưa được khai trong duyet.js: ${[...lostTypes].join(', ')}. ` +
        `Những dòng này KHÔNG hiện trong hộp thư. Khai thêm vào MODULE_BY_TYPE, SECTIONS và idsByType.`,
    );
  }

  const [bctcs, totrinhs, contracts, bills] = await Promise.all([
    idsByType.bctc.length
      ? supabase.from('bctc_revisions').select('id, doc_number, status, project_id, created_at, projects(code)').in('id', idsByType.bctc)
      : { data: [] },
    idsByType.totrinh.length
      ? supabase.from('to_trinh_chu_truong').select('id, doc_number, title, status, project_id, projects(code)').in('id', idsByType.totrinh)
      : { data: [] },
    idsByType.contract.length
      ? supabase.from('contracts').select('id, doc_number, value, status, project_id, partners(name), projects(code)').in('id', idsByType.contract)
      : { data: [] },
    idsByType.bill.length
      ? supabase.from('bills').select('id, doc_number, period_no, val_a, val_b, val_d, val_e, val_f, val_g, val_h, val_i, vat_rate, status, project_id, partners(name), projects(code)').in('id', idsByType.bill)
      : { data: [] },
  ]);

  // Báo lên console nếu một trong các truy vấn gãy — bản cũ nuốt lỗi, hồ sơ cứ
  // thế biến mất mà không ai biết vì sao.
  [
    ['bctc_revisions', bctcs],
    ['to_trinh_chu_truong', totrinhs],
    ['contracts', contracts],
    ['bills', bills],
  ].forEach(([name, res]) => {
    if (res && res.error) console.error(`[duyet.js] Lỗi tải ${name}:`, res.error);
  });

  const bctcMap = Object.fromEntries((bctcs.data || []).map((r) => [r.id, r]));
  const totrinhMap = Object.fromEntries((totrinhs.data || []).map((t) => [t.id, t]));
  const contractMap = Object.fromEntries((contracts.data || []).map((c) => [c.id, c]));
  const billMap = Object.fromEntries((bills.data || []).map((b) => [b.id, b]));

  const rows = mine
    .map((m) => {
      if (m.document_type === 'bctc') {
        const r = bctcMap[m.document_id];
        if (!r) return null;
        // BCTC là báo cáo của cả dự án: không có đối tác, không có giá trị hợp
        // đồng / sản lượng / đề nghị đợt. Khung BCTC dùng bộ cột RIÊNG bên dưới
        // thay vì nhồi 3 dấu "—" vào cột mang tên khác — đọc sai nghĩa.
        return { ...m, docNumber: r.doc_number || '—', projectCode: r.projects?.code, docDate: r.created_at, label: 'Báo cáo tài chính', status: r.status };
      }
      if (m.document_type === 'totrinh') {
        const t = totrinhMap[m.document_id];
        if (!t) return null;
        return { ...m, docNumber: t.doc_number, projectCode: t.projects?.code, partner: '—', label: 'Tờ trình chủ trương', contractValue: null, sanLuong: null, deNghi: null, status: t.status };
      }
      if (m.document_type === 'contract') {
        const c = contractMap[m.document_id];
        if (!c) return null;
        return { ...m, docNumber: c.doc_number, projectCode: c.projects?.code, partner: c.partners?.name, label: 'Hợp đồng', contractValue: c.value, sanLuong: null, deNghi: c.value, status: c.status };
      }
      const b = billMap[m.document_id];
      if (!b) return null;
      const { C, K } = calcBill(b);
      return { ...m, docNumber: `${b.doc_number}${b.period_no ? ` (Kỳ ${b.period_no})` : ''}`, projectCode: b.projects?.code, partner: b.partners?.name, label: 'Bill thanh toán', contractValue: C, sanLuong: b.val_d, deNghi: K, status: b.status };
    })
    .filter(Boolean)
    .sort((a, b) => {
      // Trễ hạn lên đầu. Cùng nhóm thì hồ sơ CHỜ LÂU NHẤT lên trước — đây là
      // hàng đợi xử lý, cái nằm lâu nhất là cái sắp trễ. (Khác 3 trang danh sách
      // Tờ trình/Hợp đồng/Bill: ở đó xếp theo tác vụ MỚI NHẤT để theo dõi.)
      const d = (isOverdue(b) ? 1 : 0) - (isOverdue(a) ? 1 : 0);
      if (d !== 0) return d;
      return new Date(a.created_at) - new Date(b.created_at);
    });

  const overdueCount = rows.filter(isOverdue).length;

  const byType = { bctc: [], totrinh: [], contract: [], bill: [] };
  rows.forEach((r) => byType[r.document_type]?.push(r));

  const CELL = 'padding:3px 8px;font-size:12px;line-height:1.3'; // dòng gọn còn ~nửa chiều cao mặc định

  // ⭐ THÊM LOẠI HỒ SƠ MỚI (4/4) — nếu loại mới có bộ cột riêng thì khai ở đây
  function headHtml(type) {
    if (type === 'bctc') {
      return IS_MOBILE
        ? `<tr><th style="${CELL}">Dự án</th><th style="${CELL}">Số hồ sơ</th><th style="${CELL}">Trạng thái</th></tr>`
        : `<tr><th style="${CELL}">Dự án</th><th style="${CELL}">Số hồ sơ</th><th style="${CELL}">Ngày lập</th><th style="${CELL}">Trạng thái</th></tr>`;
    }
    return IS_MOBILE
      ? `<tr><th style="${CELL}">Dự án</th><th style="${CELL}">Đối tác</th><th style="${CELL}">Trạng thái</th></tr>`
      : `<tr><th style="${CELL}">Dự án</th><th style="${CELL}">Số hồ sơ</th><th style="${CELL}">Đối tác</th><th style="${CELL}">Giá trị Hợp đồng</th><th style="${CELL}">Tổng sản lượng</th><th style="${CELL}">Đề nghị đợt này</th><th style="${CELL}">Trạng thái</th></tr>`;
  }

  const colCount = (type) => (type === 'bctc' ? (IS_MOBILE ? 3 : 4) : IS_MOBILE ? 3 : 7);

  function rowHtml(r) {
    // Trạng thái + "Trễ" nằm CHUNG 1 dòng (không xuống hàng) để không đội thêm
    // chiều cao dòng — khác cách làm trước đây dùng <div> tách riêng.
    const statusCell = `${statusBadge(r.status)}${isOverdue(r) ? ' <span style="color:var(--red);font-weight:700;font-size:10.5px;white-space:nowrap">⚠️ Trễ</span>' : ''}`;
    const open = `<tr class="click" data-type="${r.document_type}" data-id="${r.document_id}">`;
    const proj = `<td style="${CELL}"><span class="badge idle">${r.projectCode || '—'}</span></td>`;

    if (r.document_type === 'bctc') {
      if (IS_MOBILE) {
        return `${open}${proj}
      <td class="mono" style="${CELL}">${r.docNumber}</td>
      <td style="${CELL}">${statusCell}</td>
    </tr>`;
      }
      return `${open}${proj}
      <td class="mono" style="${CELL}">${r.docNumber}</td>
      <td style="${CELL};white-space:nowrap">${dmy(r.docDate)}</td>
      <td style="${CELL};white-space:nowrap">${statusCell}</td>
    </tr>`;
    }

    if (IS_MOBILE) {
      return `${open}${proj}
      <td style="${CELL}">${r.partner || '—'}</td>
      <td style="${CELL}">${statusCell}</td>
    </tr>`;
    }
    return `${open}${proj}
      <td class="mono" style="${CELL}">${r.docNumber}</td>
      <td style="${CELL}">${r.partner || '—'}</td>
      <td class="mono" style="${CELL}">${r.contractValue != null ? fmt(r.contractValue) : '—'}</td>
      <td class="mono" style="${CELL}">${r.sanLuong != null ? fmt(r.sanLuong) : '—'}</td>
      <td class="mono" style="${CELL}">${r.deNghi != null ? fmt(r.deNghi) : '—'}</td>
      <td style="${CELL};white-space:nowrap">${statusCell}</td>
    </tr>`;
  }

  function sectionHtml(title, type, items) {
    return `<div class="card" style="padding:0;overflow:hidden;margin-bottom:14px">
      <div style="padding:9px 14px;border-bottom:1px solid var(--gray1);font-weight:700;font-size:13px;display:flex;justify-content:space-between;align-items:center">
        <span>${title}</span><span class="badge idle">${items.length}</span>
      </div>
      <div style="max-height:360px;overflow-y:auto;overflow-x:auto">
        <table><thead>${headHtml(type)}</thead><tbody>
        ${items.length ? items.map(rowHtml).join('') : `<tr><td colspan="${colCount(type)}" style="text-align:center;color:var(--gray4);padding:16px">Không có hồ sơ nào</td></tr>`}
        </tbody></table>
      </div>
    </div>`;
  }

  // CHẶN TRANG TRẮNG: có dòng chờ duyệt nhưng không dựng được dòng nào để hiện
  // -> nghĩa là luật XEM (RLS) của bảng hồ sơ đang chặn chính người được phân
  // công duyệt. Đúng cái lỗi đã gặp với BCTC ngày 25/09. Bản cũ luôn vẽ 3 khung
  // nên còn thấy cái gì đó; nay ẩn khung rỗng thì phải nói rõ ra, không được im.
  if (rows.length === 0) {
    const kinds = [...new Set(mine.map((m) => m.document_type))].join(', ');
    console.error(`[duyet.js] Có ${mine.length} dòng chờ duyệt (${kinds}) nhưng không đọc được hồ sơ nào — nghi RLS chặn người duyệt.`);
    container.innerHTML = `<div class="card empty-note">
      <div style="font-size:30px;margin-bottom:8px">🔒</div>
      <div style="font-weight:600;color:var(--gray7);margin-bottom:3px">Bạn có ${mine.length} hồ sơ chờ duyệt nhưng hệ thống không mở được</div>
      <div>Quyền xem hồ sơ đang chặn chính người được phân công duyệt (loại hồ sơ: ${kinds}).<br>Báo quản trị hệ thống kiểm tra quyền xem — đây là lỗi phân quyền, không phải do bạn.</div>
    </div>`;
    return;
  }

  // Chỉ vẽ khung nào CÓ hồ sơ. Hai trường hợp ra trang trắng đều đã chặn ở trên.
  const visible = SECTIONS.filter((s) => byType[s.type].length);

  container.innerHTML = `
    ${overdueCount ? `<div style="font-size:12.5px;background:#FEF2F2;color:var(--red);padding:9px 12px;border-radius:7px;margin-bottom:12px">⚠️ <b>${overdueCount} hồ sơ</b> đang trễ hạn duyệt — xem các dòng có nhãn đỏ bên dưới.</div>` : ''}
    ${visible.map((s) => sectionHtml(s.title, s.type, byType[s.type])).join('')}
  `;

  container.querySelectorAll('[data-type]').forEach((row) =>
    row.addEventListener('click', async () => {
      const type = row.dataset.type;
      const id = row.dataset.id;
      const file = MODULE_BY_TYPE[type];
      if (!file) return console.error(`[duyet.js] Không biết mở loại hồ sơ '${type}'.`);
      const mod = await import(`./${file}.js`);
      if (typeof mod.openDetail === 'function') {
        mod.openDetail(id, user, () => render(container, user));
      } else {
        // Module đó chưa có hàm openDetail(id, user, onDone). Thay vì bấm không
        // ăn, chuyển người dùng sang tab của loại hồ sơ đó.
        // XÁC NHẬN 08/10 từ shell.js: mã tab = TÊN FILE module (hàm loadModule nạp
        // theo tên), nên phải dùng `file` chứ KHÔNG phải `type`. Bản 03/10 tôi viết
        // `#${type}` — với BCTC thì trùng nhau nên vẫn chạy, nhưng hợp đồng sẽ ra
        // '#contract' trong khi mã tab thật là '#hopdong' -> bấm không ăn gì.
        console.warn(`[duyet.js] ${file}.js chưa có openDetail() — chuyển sang tab #${file}.`);
        location.hash = `#${file}`;
      }
    }),
  );
}
