// ============================================================
// dashboard.js — Tổng quan: 3 ô số · biểu đồ Doanh thu–Sản lượng theo dự án ·
// Cam kết theo loại hợp đồng · Dự án đang âm. Dữ liệu lấy thật từ Supabase,
// RLS tự lọc theo vai trò nên module này không tự kiểm tra quyền.
//
// ⚠️ HAI CỘT LẤY NGƯỢC NHAU — CỐ Ý, ĐỪNG 'SỬA CHO ĐỒNG BỘ':
//   · GIÁ TRỊ HĐ: chỉ lấy đợt claim MỚI NHẤT (mỗi phiếu chụp lại giá trị HĐ tại
//     thời điểm đó; cộng dồn 3 đợt = gấp 3 mà vẫn ra số trông hợp lý).
//   · DOANH THU: CỘNG mọi đợt (amount_before_vat là phần tăng thêm của riêng kỳ).
//     Đợt 2 trở đi chỉ nhập PHẦN TĂNG THÊM, nhập lũy kế là cộng đôi.
// ============================================================
import { supabase } from '../core/config.js';
import { fmt, IS_MOBILE } from '../core/utils.js';
// Vai trò cấp toàn công ty — nhập từ shell.js, KHÔNG chép lại (sửa 1 chỗ quên chỗ kia).
import { COMPANY_WIDE_ROLES } from '../core/shell.js';

// Chống vỡ HTML khi tên đối tác/dự án có ký tự đặc biệt (&, <, ">, dấu nháy)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

const DOC_TYPE_LABEL = { contract: 'Hợp đồng', bill: 'Bill', totrinh: 'Tờ trình', bctc: 'BCTC' };

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải dữ liệu…</div>`;

  const isTopLevel = (user.roles || []).some((r) => COMPANY_WIDE_ROLES.includes(r));

  const [{ data: projects }, { data: contracts }, { data: bills }, { data: myAssignments }, { data: claims }] =
    await Promise.all([
      supabase.from('projects').select('id, code, name').order('code'),
          // status/projects để tra dự án; contract_type cho khối Cam kết
      supabase.from('contracts').select('id, doc_number, value, value_adjustment, status, contract_type, parent_contract_id, project_id, origin_department, partners(name), projects(code, name)'),
          // ⚠️ KHÔNG lấy val_e..val_h — chốt 20/11: chi phí CHỈ tính theo sản lượng (val_d).
          //   Lấy về mà không dùng chỉ khiến người đọc sau tưởng công thức vẫn cộng mấy ô đó.
      supabase.from('bills').select('id, doc_number, contract_id, project_id, partner_id, period_no, status, val_d, vat_rate'),
      supabase.from('project_role_assignments').select('role_type, project_id, projects(code)').eq('user_id', user.id).is('effective_to', null),
      // contract_amount + vo_amount: nguồn cột "Giá trị HĐ"
      supabase.from('owner_progress_claims').select('project_id, claim_no, amount_before_vat, contract_amount, vo_amount, confirmed_date'),
    ]);


  if (!projects || projects.length === 0) {
    container.innerHTML = `<div class="empty-note">Chưa có dự án nào trong hệ thống, hoặc bạn chưa được phân công dự án nào.</div>`;
    return;
  }

      // Người CÓ gắn dự án cụ thể (CHT/GĐDA/QS...) chỉ thấy dự án đó; vai trò văn
      // phòng thuần (Kế toán/Pháp chế/QLCP&HĐ) vẫn thấy toàn bộ, đúng vai trò của họ.
  const myProjectIds = new Set((myAssignments || []).map((a) => a.project_id).filter(Boolean));
  const isSiteLimited = myProjectIds.size > 0 && !(user.roles || []).some((r) => COMPANY_WIDE_ROLES.includes(r));



      // ============================================================
      // SỐ THEO DỰ ÁN. ⚠️ Nhãn 'Sản lượng' nhưng biến vẫn tên chiPhi — cố ý giữ.
          //   chia (1+VAT) về trước thuế. BẢN CŨ LẤY I = D+E+F+G+H VÀ ĐÓ LÀ SAI:
          //   F = tạm ứng (khối lượng CHƯA LÀM — VEGA20CAN-MEP phồng 515 triệu),
          //   E = giữ lại (bị trừ dù công đã làm — HANGHAI thiếu 1,01 tỷ).
          //   Toàn công ty thiếu ~2,18 tỷ. Nay hai vế cùng thước đo nên Chênh lệch
          //   mới đúng nghĩa LÃI GỘP THỰC HIỆN. ⚠️ KHÁC 'tiền đã chi'.
          // Gom theo hợp đồng; bill chưa gắn HĐ gom theo Dự án+Đối tác để không sót.
          // ============================================================
  const validBills = (bills || []).filter((b) => !['draft', 'cancelled', 'rejected'].includes(b.status));
  const latestBillByGroup = {};
  validBills.forEach((b) => {
    const key = b.contract_id || `np:${b.project_id}|${b.partner_id}`;
    const cur = latestBillByGroup[key];
    if (!cur || Number(b.period_no || 0) > Number(cur.period_no || 0)) latestBillByGroup[key] = b;
  });
  const costByProject = {};
  Object.values(latestBillByGroup).forEach((b) => {
    const projectId = b.project_id || contractById2(b.contract_id)?.project_id;
    if (!projectId) return;
    const div = 1 + (Number(b.vat_rate ?? 8) || 0) / 100;
    costByProject[projectId] = (costByProject[projectId] || 0) + Math.round(Number(b.val_d || 0) / (div || 1));
  });
  function contractById2(id) {
    if (!id) return null;
    return (contracts || []).find((c) => c.id === id) || null;
  }

  // GIÁ TRỊ HĐ — ĐỢT CLAIM MỚI NHẤT mỗi dự án, KHÔNG cộng dồn (xem đầu file).
  const latestClaimByProject = {};
  (claims || []).forEach((r) => {
    const cur = latestClaimByProject[r.project_id];
    if (!cur || Number(r.claim_no || 0) > Number(cur.claim_no || 0)) latestClaimByProject[r.project_id] = r;
  });
  const contractValueByProject = {};
  Object.entries(latestClaimByProject).forEach(([pid, r]) => {
    const v = Number(r.contract_amount || 0) + Number(r.vo_amount || 0);
    contractValueByProject[pid] = v > 0 ? v : null; // 0 hoặc trống = coi như CHƯA NHẬP, để còn nhắc
  });

  // DOANH THU — CỘNG mọi đợt (ngược cột trên, xem đầu file).
  const claimByProject = {};
  (claims || []).forEach((r) => (claimByProject[r.project_id] = (claimByProject[r.project_id] || 0) + Number(r.amount_before_vat || 0)));

  // CHT/GĐDA/QS: chỉ dự án mình phụ trách. Vai trò cấp công ty: xem hết.
  const summaryProjects = (projects || []).filter((p) => (isSiteLimited ? myProjectIds.has(p.id) : true));

  const summaryRows = summaryProjects.map((p) => {
    const giaTriHD = contractValueByProject[p.id] ?? null; // null = chưa nhập giá trị HĐ trên phiếu claim
    const doanhThu = claimByProject[p.id] || 0;
    const chiPhi = costByProject[p.id] || 0;
    const chenhLech = doanhThu - chiPhi;
    const thuPct = giaTriHD ? (doanhThu / giaTriHD) * 100 : null;
    return { p, giaTriHD, doanhThu, chiPhi, chenhLech, thuPct };
  });

  const tGiaTriHD = summaryRows.reduce((s2, r) => s2 + (r.giaTriHD || 0), 0);
  const tDoanhThu = summaryRows.reduce((s2, r) => s2 + r.doanhThu, 0);
  const tChiPhi = summaryRows.reduce((s2, r) => s2 + r.chiPhi, 0);
  const tChenhLech = tDoanhThu - tChiPhi;

  const tyVnd = (n) => (Number(n) / 1e9).toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  // Chênh lệch 2 số lẻ: 1 số lẻ thì 149 và 126 triệu đều ra "0,1 tỷ".
  const tyVnd2 = (n) => (Number(n) / 1e9).toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct1 = (v) => Number(v).toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  // Dưới 1% ghi "<1" — làm tròn về 0 khiến người đọc tưởng chưa claim đồng nào
  const pctInt = (v) => (v > 0 && v < 1 ? '<1' : Math.round(v).toLocaleString('vi-VN'));

      // Xếp theo chênh lệch từ cao xuống thấp — dự án âm rơi xuống cuối, đúng chỗ người đọc tìm.




      // ============================================================
      // BỐ CỤC 20/11 — trang này CEO và PTGĐ đọc trực tiếp.
      // ⚠️ KHÔNG dựng 3 khối Ngân sách–Thực tế / Phải thu / Phải trả: soi DB 20/11
      //   thấy chỉ 1/11 dự án có BCTC còn hiệu lực, claim không có ô 'CĐT đã trả',
      //   bill không có trạng thái 'đã duyệt, chưa chi'. Vẽ ô trống cho lãnh đạo xem
      //   còn tệ hơn không vẽ.
      // ⚠️ Lấy NGUYÊN số từ summaryRows/tGiaTriHD ở trên, KHÔNG tính lại.
      // ============================================================

  const amRows = summaryRows.filter((r) => r.chenhLech < 0).sort((a, b) => a.chenhLech - b.chenhLech);

      // Ô 'Chênh lệch' tổng đã bỏ 20/11 theo yêu cầu — còn 3 ô, xem chênh lệch theo
      // từng dự án trên biểu đồ. ⚠️ Điện thoại 3 ô MỘT HÀNG, nhãn ngắn lại: bản cũ
      // xếp 2+1 với nhãn dài, 3 con số ăn gần 1/4 màn hình.
  const TILES = [
    { k: IS_MOBILE ? 'Giá trị HĐ' : 'Giá trị hợp đồng đã ký với CĐT', v: tyVnd(tGiaTriHD), color: '',
      f: IS_MOBILE ? '' : `${fmt(tGiaTriHD)} đ` },
    { k: IS_MOBILE ? 'Doanh thu' : 'Doanh thu — CĐT đã xác nhận', v: tyVnd(tDoanhThu), color: '#2a78d6',
      f: tGiaTriHD ? `đạt ${pct1((tDoanhThu / tGiaTriHD) * 100)}%${IS_MOBILE ? ' HĐ' : ' giá trị hợp đồng'}` : 'chưa có giá trị HĐ' },
    { k: IS_MOBILE ? 'Sản lượng' : 'Sản lượng — tổng bill các đơn vị', v: tyVnd(tChiPhi), color: '#eb6834',
      f: tDoanhThu ? `bằng ${pct1((tChiPhi / tDoanhThu) * 100)}%${IS_MOBILE ? ' DT' : ' doanh thu'}` : '—' },
  ];
  const tilesHtml = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:${IS_MOBILE ? 8 : 14}px;margin-bottom:${IS_MOBILE ? 12 : 16}px">
      ${TILES.map((t) => `<div class="card" style="${IS_MOBILE ? 'padding:10px 11px' : ''}">
        <div class="card-sub" style="margin:0 0 4px;${IS_MOBILE ? 'font-size:11px;white-space:nowrap' : ''}">${t.k}</div>
        <div style="font-size:${IS_MOBILE ? 19 : 29}px;font-weight:800;letter-spacing:-.5px;white-space:nowrap;${t.color ? `color:${t.color}` : ''}">${t.v} tỷ</div>
        ${t.f ? `<div style="font-size:${IS_MOBILE ? 10.5 : 11.5}px;color:var(--gray4);margin-top:4px;white-space:nowrap">${t.f}</div>` : ''}
      </div>`).join('')}
    </div>`;

      // ---- Biểu đồ Doanh thu vs Sản lượng ----
      // Xanh #2a78d6 / cam #eb6834: người mù màu vẫn phân biệt (ΔE 24,7).
      // ⚠️ Số nằm ngay sau mỗi thanh nên BAR_W phải chừa chỗ: thanh dài nhất + nhãn
      //   vẫn chưa chạm cột chênh lệch. Sửa BAR_W mà quên dời LAB_X là chữ đè nhau.
  const chartRows = [...summaryRows].sort((a, b) => b.chenhLech - a.chenhLech);
  const maxChart = Math.max(1, ...chartRows.map((r) => Math.max(r.doanhThu, r.chiPhi)));

      // ⚠️ HAI HÌNH DẠNG KHÁC HẲN, KHÔNG PHẢI MỘT HÌNH THU NHỎ: máy tính xếp NGANG
      //   (tên | thanh | chênh lệch), màn hẹp xếp DỌC (tên+chênh lệch một dòng, hai
      //   thanh nằm dưới). Bê khung 1060px xuống màn 412px thì chữ co còn ~5px.
      //
      // ⚠️ KHUNG MÀN HẸP ĐO THEO BỀ NGANG MÁY, KHÔNG ĐẶT CỨNG (sửa 20/11): IS_MOBILE
      //   trong utils.js xét user-agent, KHÔNG xét bề ngang — màn gập mở ra vẫn là
      //   IS_MOBILE nhưng rộng gấp đôi, khung cứng 400px bị phóng ~1,7 lần, CHỮ TO VỐNG.
      //   Nay lấy innerWidth trừ lề (≈48), chặn trong [330, 760].
  const VPW = (typeof window !== 'undefined' && window.innerWidth) || 400;
  const mobW = Math.max(330, Math.min(VPW - 48, 760));
  const CH = IS_MOBILE
    ? { W: mobW, ROW: 62, BAR_X: 0, BAR_W: mobW - 50, BAR_H: 12, PAD_TOP: 16, PAD_BOT: 24 }
    : { W: 1060, ROW: 50, BAR_X: 262, BAR_W: 420, BAR_H: 14, PAD_TOP: 34, PAD_BOT: 46 };
  const LAB_X = CH.BAR_X + CH.BAR_W + 82;   // mốc cột "Chênh lệch" (chỉ máy tính)
  const chartH = chartRows.length * CH.ROW + CH.PAD_BOT;
  const barLen = (v) => (v > 0 ? Math.max(3, (v / maxChart) * CH.BAR_W) : 0);

  const tickStep = maxChart > 40e9 ? 10e9 : maxChart > 15e9 ? 5e9 : maxChart > 5e9 ? 2e9 : 1e9;
  let gridSvg = '';
  for (let t = 0; t <= maxChart; t += tickStep) {
    const x = CH.BAR_X + (t / maxChart) * CH.BAR_W;
    // Vạch đầu căn trái, vạch cuối căn phải — căn giữa thì nửa chữ số lòi ra
    // ngoài khung svg và bị cắt mất (lỗi thấy trên màn gập 412px).
    const anchor = t === 0 ? 'start' : t + tickStep > maxChart ? 'end' : 'middle';
    gridSvg += `<line x1="${x}" y1="${IS_MOBILE ? 4 : 28}" x2="${x}" y2="${chartH - 18}" stroke="var(--gray2)" stroke-width="1"/>
      <text x="${x}" y="${chartH - 4}" text-anchor="${anchor}" font-size="10.5" fill="var(--gray4)">${t / 1e9}</text>`;
  }

  const tip = (r) => `${esc(r.p.code)} — ${esc(r.p.name)}
Giá trị HĐ: ${r.giaTriHD == null ? 'chưa nhập' : fmt(r.giaTriHD) + ' đ'}
Doanh thu: ${fmt(r.doanhThu)} đ
Sản lượng: ${fmt(r.chiPhi)} đ
Chênh lệch: ${r.chenhLech >= 0 ? '+' : '−'}${fmt(Math.abs(r.chenhLech))} đ`;

  const barsSvg = chartRows.map((r, i) => {
    const y = CH.PAD_TOP + i * CH.ROW;
    const neg = r.chenhLech < 0;
    const wDt = barLen(r.doanhThu), wSl = barLen(r.chiPhi);
    const col = neg ? 'var(--red)' : 'var(--green)';
    const chenh = `${neg ? '−' : '+'}${tyVnd2(Math.abs(r.chenhLech))} tỷ`;
    const hd = r.giaTriHD == null ? 'chưa có giá trị HĐ' : `HĐ ${tyVnd(r.giaTriHD)} tỷ`;
    const pctTxt = r.thuPct == null ? '' : `đạt ${pctInt(r.thuPct)}% HĐ`;

    if (IS_MOBILE) {
      // Dòng 1: mã dự án (trái) · chênh lệch (phải). Dòng 2: giá trị HĐ · % HĐ.
      // Dòng 3-4: hai thanh, số ngay sau đuôi thanh.
      return `<g><title>${tip(r)}</title>
      <text x="0" y="${y}" font-size="12.5" font-weight="700" fill="var(--gray7)">${esc(r.p.code)}</text>
      <text x="${CH.W}" y="${y}" text-anchor="end" font-size="12.5" font-weight="700" fill="${col}">${chenh}</text>
      <text x="0" y="${y + 13}" font-size="10" fill="var(--gray4)">${hd}</text>
      <text x="${CH.W}" y="${y + 13}" text-anchor="end" font-size="10" fill="var(--gray4)">${pctTxt}</text>
      <rect x="0" y="${y + 19}" width="${wDt}" height="${CH.BAR_H}" rx="3" fill="#2a78d6"/>
      <text x="${wDt + 6}" y="${y + 29}" font-size="10.5" font-weight="600" fill="var(--gray7)">${tyVnd2(r.doanhThu)}</text>
      <rect x="0" y="${y + 19 + CH.BAR_H + 2}" width="${wSl}" height="${CH.BAR_H}" rx="3" fill="#eb6834"/>
      <text x="${wSl + 6}" y="${y + 29 + CH.BAR_H + 2}" font-size="10.5" font-weight="600" fill="var(--gray7)">${tyVnd2(r.chiPhi)}</text>
    </g>`;
    }
    return `<g><title>${tip(r)}</title>
      <rect x="0" y="${y - 10}" width="${CH.W}" height="${CH.ROW - 6}" fill="transparent"/>
      <text x="250" y="${y + 12}" text-anchor="end" font-size="13.5" font-weight="700" fill="var(--gray7)">${esc(r.p.code)}</text>
      <text x="250" y="${y + 27}" text-anchor="end" font-size="10.5" fill="var(--gray4)">${hd}</text>
      <rect x="${CH.BAR_X}" y="${y}" width="${wDt}" height="${CH.BAR_H}" rx="4" fill="#2a78d6"/>
      <text x="${CH.BAR_X + wDt + 7}" y="${y + 12}" font-size="11.5" font-weight="600" fill="var(--gray7)">${tyVnd(r.doanhThu)}</text>
      <rect x="${CH.BAR_X}" y="${y + CH.BAR_H + 2}" width="${wSl}" height="${CH.BAR_H}" rx="4" fill="#eb6834"/>
      <text x="${CH.BAR_X + wSl + 7}" y="${y + CH.BAR_H + 14}" font-size="11.5" font-weight="600" fill="var(--gray7)">${tyVnd(r.chiPhi)}</text>
      <text x="${LAB_X}" y="${y + 13}" font-size="14" font-weight="700" fill="${col}">${chenh}</text>
      <text x="${LAB_X}" y="${y + 29}" font-size="11" fill="var(--gray4)">${r.thuPct == null ? 'chưa có giá trị HĐ' : `đạt ${pctInt(r.thuPct)}% giá trị HĐ`}</text>
    </g>`;
  }).join('');

  const chartHtml = `
    <div class="card" style="margin-bottom:12px${IS_MOBILE ? ';padding:14px 12px' : ''}">
      <div class="card-title" style="margin:0">Doanh thu và sản lượng theo dự án</div>
      <div class="card-sub">Xếp theo chênh lệch từ cao xuống thấp · đơn vị: tỷ đồng</div>
      <div style="display:flex;gap:${IS_MOBILE ? 12 : 18}px;margin:10px 0 2px;font-size:${IS_MOBILE ? 11.5 : 13}px;color:var(--gray6);flex-wrap:wrap">
        <span><span style="display:inline-block;width:11px;height:11px;border-radius:3px;background:#2a78d6;margin-right:6px"></span>Doanh thu${IS_MOBILE ? '' : ' (CĐT xác nhận)'}</span>
        <span><span style="display:inline-block;width:11px;height:11px;border-radius:3px;background:#eb6834;margin-right:6px"></span>Sản lượng${IS_MOBILE ? '' : ' (tổng bill các đơn vị)'}</span>
      </div>
      <!-- ⚠️ height cứng + max-width = CH.W + xMinYMin: ba thứ đi liền nhau, bỏ một
           là svg tự phóng theo container và chữ to vống (lỗi màn gập 20/11). -->
      <svg viewBox="0 0 ${CH.W} ${chartH}" width="100%" height="${chartH}"
           preserveAspectRatio="xMinYMin meet"
           style="max-width:${CH.W}px;display:block">${gridSvg}${barsSvg}</svg>
    </div>`;

  // ---- Cam kết theo loại hợp đồng -------------------------------------------
  // Giá trị hợp đồng ĐÃ KÝ với các đơn vị, không phải tiền đã chi.
  const scopeIds = new Set(summaryProjects.map((p) => p.id));
  const camKet = {};
  (contracts || []).forEach((c) => {
    if (c.status === 'cancelled') return;
    if (!scopeIds.has(c.project_id)) return;
    const k = c.contract_type || '(chưa phân loại)';
    camKet[k] = (camKet[k] || 0) + Number(c.value || 0);
  });
  let camKetList = Object.entries(camKet).sort((a, b) => b[1] - a[1]);
  // Quá 5 loại thì gộp đuôi lại — bảng xếp hạng dài không ai đọc tới dòng thứ 7
  if (camKetList.length > 5) {
    const khac = camKetList.slice(4).reduce((s, x) => s + x[1], 0);
    camKetList = [...camKetList.slice(0, 4), ['Các loại khác', khac]];
  }
  const camKetTong = camKetList.reduce((s, x) => s + x[1], 0);
  const camKetMax = Math.max(1, ...camKetList.map((x) => x[1]));
  const camKetHtml = camKetList.length
    ? `<div class="card" style="margin-bottom:16px">
        <div class="card-title" style="margin:0">Cam kết theo loại hợp đồng</div>
        <div class="card-sub">Giá trị hợp đồng đã ký với các đơn vị · tổng ${tyVnd(camKetTong)} tỷ</div>
        <div style="margin-top:12px">
          ${camKetList.map(([ten, v]) => `
            <div style="margin-bottom:13px">
              <div style="font-size:12.5px;color:var(--gray6);margin-bottom:5px">${esc(ten)}</div>
              <div style="display:flex;align-items:center;gap:9px">
                <div style="height:15px;border-radius:4px;background:#2a78d6;width:${Math.max(2, (v / camKetMax) * 100)}%;max-width:100%"></div>
                <div style="font-size:12.5px;font-weight:700;white-space:nowrap">${tyVnd(v)} tỷ</div>
              </div>
            </div>`).join('')}
        </div>
      </div>`
    : '';

      // Khối 'Việc đang chờ xử lý' đã bỏ 20/11 — đã tra được ở tab Duyệt hồ sơ / Hồ sơ của tôi.

  // ---- Dự án đang âm ---------------------------------------------------------
  const amHtml = amRows.length
    ? `<div class="card" style="margin-bottom:16px">
        <div class="card-title" style="margin:0">${amRows.length} dự án đang âm</div>
        <div class="card-sub">Sản lượng đã vượt doanh thu CĐT xác nhận</div>
        ${amRows.map((r) => `
          <div style="border-left:3px solid var(--red);padding:9px 0 9px 12px;margin-top:11px">
            <div style="font-size:13px;font-weight:700;color:var(--red)">${esc(r.p.code)} · −${fmt(Math.abs(r.chenhLech))} đ</div>
            <div style="font-size:12px;color:var(--gray6);margin-top:4px;line-height:1.6">
              Sản lượng ${tyVnd(r.chiPhi)} tỷ so với doanh thu ${tyVnd(r.doanhThu)} tỷ${r.thuPct != null ? ` — CĐT mới xác nhận ${pctInt(r.thuPct)}% giá trị hợp đồng` : ' — dự án chưa có hợp đồng CĐT'}.
            </div>
          </div>`).join('')}
      </div>`
    : '';


      // Nén cho vừa MỘT màn hình (20/11): chỉ thu padding, KHÔNG thu cỡ chữ số tiền
      // — lãnh đạo đọc con số, không đọc khoảng trắng.
  const compactCss = `<style>
    #dashCompact .card{margin-bottom:12px}
    #dashCompact td{padding:7px 10px}
    #dashCompact th{padding:7px 10px}
    #dashCompact .card-sub{margin-bottom:8px}
  </style>`;

  container.innerHTML =
    compactCss +
    '<div id="dashCompact">' +
    tilesHtml +
    (IS_MOBILE
      ? chartHtml + camKetHtml + amHtml
      : `<div style="display:grid;grid-template-columns:minmax(0,2.2fr) minmax(300px,1fr);gap:16px;align-items:start">
           <div>${chartHtml}</div>
           <div>${camKetHtml}${amHtml}</div>
         </div>`) +
    '</div>';
}
