// ============================================================
// attachments.js — Đính kèm file (PDF/Word/Excel/ảnh), tối đa 10 file/hồ sơ.
// Dùng chung cho hopdong.js, bill.js, totrinh.js — gọi renderAttachments()
// vào đúng 1 <div id="..."> trong panel chi tiết.
// Bucket private — mở file qua signed URL (link tạm 1 giờ), không lộ đường dẫn thật.
// ============================================================
import { supabase } from './config.js';
import { toast, loading } from './utils.js';

const MAX_FILES = 10;
const BUCKET = 'attachments';

function fileIcon(name) {
  if (/\.pdf$/i.test(name)) return '📕';
  if (/\.(xlsx|xls|csv)$/i.test(name)) return '📗';
  if (/\.(docx?|)$/i.test(name) && /\.docx?$/i.test(name)) return '📘';
  if (/\.(png|jpe?g|gif|webp)$/i.test(name)) return '🖼️';
  return '📄';
}
function fmtSize(kb) {
  if (kb == null) return '';
  return kb < 1024 ? `${kb} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

// Gọi hàm này để vẽ + gắn toàn bộ chức năng vào 1 khung <div>
export async function renderAttachments(container, ownerType, ownerId, currentUserId) {
  await refresh();

  async function refresh() {
    const { data: files, error } = await supabase
      .from('attachments')
      .select('id, file_name, file_url, file_size_kb, uploaded_by, uploaded_at')
      .eq('owner_type', ownerType)
      .eq('owner_id', ownerId)
      .order('uploaded_at', { ascending: false });

    if (error) {
      container.innerHTML = `<div class="empty-note">⚠️ Không tải được danh sách file: ${error.message}</div>`;
      return;
    }

    const count = files?.length || 0;
    container.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px">
        ${count ? files.map((f) => `
          <span class="linked-chip" style="background:var(--gray1);color:var(--gray7);cursor:pointer" data-open-file="${f.id}" data-path="${f.file_url}">
            ${fileIcon(f.file_name)} ${f.file_name}
            <span style="color:var(--gray4);font-weight:400;font-size:11px">(${fmtSize(f.file_size_kb)})</span>
            ${f.uploaded_by === currentUserId ? `<span data-del-file="${f.id}" data-path="${f.file_url}" style="cursor:pointer;color:var(--red);font-weight:700;margin-left:2px">✕</span>` : ''}
          </span>`).join('') : '<span style="color:var(--gray4);font-size:12px">Chưa có file đính kèm</span>'}
      </div>
      <input type="file" id="fileInput" style="display:none" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.png,.jpg,.jpeg">
      <button class="btn btn-sm btn-secondary" id="btnAddFile" ${count >= MAX_FILES ? 'disabled' : ''}>+ Thêm file (PDF, Word, Excel, ảnh)</button>
      <div style="font-size:11px;color:var(--gray4);margin-top:5px">${count}/${MAX_FILES} file — tối đa ${MAX_FILES} file mỗi hồ sơ.</div>
    `;

    container.querySelector('#btnAddFile')?.addEventListener('click', () => container.querySelector('#fileInput').click());
    container.querySelector('#fileInput')?.addEventListener('change', async (e) => {
      const chosen = [...e.target.files];
      if (count + chosen.length > MAX_FILES) {
        toast(`Chỉ được tối đa ${MAX_FILES} file — hiện có ${count}, chỉ thêm được ${MAX_FILES - count} nữa`, 'error');
        e.target.value = '';
        return;
      }
      for (const file of chosen) await uploadOne(file);
      e.target.value = '';
      refresh();
    });

    container.querySelectorAll('[data-open-file]').forEach((el) =>
      el.addEventListener('click', async (e) => {
        if (e.target.closest('[data-del-file]')) return; // bấm nút xóa thì không mở file
        const { data, error: signErr } = await supabase.storage.from(BUCKET).createSignedUrl(el.dataset.path, 3600);
        if (signErr) return toast('Không mở được file: ' + signErr.message, 'error');
        window.open(data.signedUrl, '_blank');
      }),
    );

    container.querySelectorAll('[data-del-file]').forEach((el) =>
      el.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (!confirm('Xóa file này khỏi hồ sơ?')) return;
        await supabase.storage.from(BUCKET).remove([el.dataset.path]);
        await supabase.from('attachments').delete().eq('id', el.dataset.delFile);
        toast('Đã xóa file', 'success');
        refresh();
      }),
    );
  }

  async function uploadOne(file) {
    if (file.size > 20 * 1024 * 1024) {
      toast(`File "${file.name}" vượt quá 20MB, không tải lên được`, 'error');
      return;
    }
    loading(true, `Đang tải lên: ${file.name}`);
    const path = `${ownerType}/${ownerId}/${Date.now()}_${file.name.replace(/[^\w.\-]/g, '_')}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file);
    if (upErr) {
      toast(`Lỗi tải file "${file.name}": ${upErr.message}`, 'error');
      return;
    }
    const { error: insErr } = await supabase.from('attachments').insert({
      owner_type: ownerType,
      owner_id: ownerId,
      file_name: file.name,
      file_url: path,
      file_size_kb: Math.round(file.size / 1024),
      uploaded_by: currentUserId,
    });
    if (insErr) {
      toast(`Đã tải file lên nhưng lỗi ghi nhận: ${insErr.message}`, 'error');
      return;
    }
    toast(`Đã thêm "${file.name}"`, 'success');
  }
}
