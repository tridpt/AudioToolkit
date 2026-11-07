# Audio Toolkit

Workspace tiếng Việt dành cho podcaster, giáo viên và người phỏng vấn: nhập bản thu → lọc tiếng ồn → transcript → tách người nói → ghi chú có mốc thời gian.

## Chạy trên Windows

```powershell
cd D:\App\AudioToolkit
npm install
npm run setup:ai
npm start
```

Mở **http://127.0.0.1:4188** hoặc chạy `run.bat`. Cần Node.js 22+; script cài AI dùng `uv` và Python 3.12 nếu có, hoặc Python hiện có. FFmpeg và ffprobe được cài qua npm. Không cần API key.

Giao diện phải được mở qua máy chủ này. Mở riêng `public/index.html` sẽ không kết nối được API.

## Tính năng đã triển khai

- Nhập/kéo thả MP3, WAV, M4A, AAC, FLAC, OGG, WebM; tối đa 250 MB và 2 giờ. File được kiểm tra bằng ffprobe, giữ bản gốc và tạo bản phát MP3.
- **Xử lý hàng loạt:** chọn/kéo thả nhiều file, hoặc mở **Công cụ → Xử lý hàng loạt**. Mỗi hàng đợi nhận tối đa 20 file, giữ giới hạn 250 MB/2 giờ cho từng file. Các file tải lên máy trước khi **Bắt đầu xử lý**, rồi máy chủ lần lượt nhập → lọc ồn → transcript → tách người nói và tạo tóm tắt. Có trạng thái/tiến độ từng file, thêm file trong lúc chạy, huỷ riêng, bỏ file chờ và **Thử lại** file lỗi/đã huỷ. Hàng đợi được lưu trên ổ đĩa, tiếp tục khi đóng tab và tự khôi phục bước chưa xong sau khi máy chủ khởi động lại. Thử lại dùng dự án và thiết lập của lần chạy trước, giữ các bước đã xong, không tạo bản sao upload.
- **Xuất ZIP hàng loạt:** chọn các bản thu đã hoàn tất và các định dạng DOCX/PDF/TXT/JSON/SRT/VTT, chọn mẫu báo cáo rồi **Xuất ZIP**. Mỗi bản thu nằm trong thư mục đánh số riêng nên hai file cùng tên không ghi đè nhau. ZIP có manifest danh sách file; không chứa âm thanh. Chỉ xuất SRT/VTT khi có transcript; nếu PDF gặp chữ chưa hỗ trợ, bỏ chọn PDF và dùng DOCX.
- **Sao lưu & khôi phục dự án:** vào **Công cụ → Sao lưu & khôi phục**, hoặc **Xuất → Sao lưu toàn bộ dự án kèm âm thanh**. Nút **Sao lưu dự án** tạo `.audiokit.zip` có audio gốc, bản chuẩn hoá, bản phát, bản đã lọc nếu có, transcript, người nói, tóm tắt/chương, ghi chú và dữ liệu AI để tiếp tục chỉnh sửa/xử lý trên máy khác. Chọn ZIP để kiểm tra, xem trước rồi khôi phục vào thư viện. Nếu dự án trùng, mở bản hiện có; nếu cùng mã nhưng nội dung khác, **Khôi phục thành bản riêng** giữ cả hai.
- **Thu âm bằng micro:** nhấn **Thu âm → Bắt đầu thu**, cho phép micro khi trình duyệt hỏi. Có tín hiệu âm thanh trực tiếp, bộ đếm thời gian, tạm dừng/tiếp tục, dừng và nghe lại, đặt tên, tải file dự phòng và **Lưu thành dự án**. Sau khi lưu, dùng lọc ồn, transcript, tóm tắt và cắt clip như file đã nhập.
- Waveform lấy từ âm thanh thật, nhấn hoặc dùng bàn phím để tua; phát/dừng, âm lượng, tốc độ 0,75–2×.
- Lọc nền ồn bằng FFmpeg `afftdn`, high-pass 70 Hz và chuẩn hoá âm lượng `loudnorm`. Có ba mức giảm nhiễu. Chuyển Bản gốc / Đã lọc ồn để nghe so sánh và tải bản MP3 đã xử lý.
- Whisper chạy CPU/int8 trên máy; chọn tiny/base/small và ngôn ngữ. Với tiếng Việt, đặt rõ ngôn ngữ và chọn small khi ưu tiên độ chính xác.
- Tách người nói thực bằng sherpa-onnx, Pyannote segmentation 3.0 và WeSpeaker voice embeddings. Tự ước lượng số người hoặc đặt 1–8 người. Nhãn là Người nói 1, 2…; tên do bạn đặt.
- Transcript có thời gian bắt đầu/kết thúc, tìm kiếm, lọc người nói, độ tin cậy từ xác suất từ của Whisper. Độ tin cậy không phải độ chính xác đã được kiểm chứng.
- Sửa văn bản trực tiếp; trong chế độ chỉnh sửa, chọn lại speaker cho từng đoạn. Sửa tên bằng thẻ người nói. Chỉnh sửa tự lưu.
- **Lịch sử phiên bản transcript:** nhấn **Lịch sử phiên bản** dưới transcript hoặc trong **Xuất**. Tự lưu bản cũ trước khi chạy lại Transcript/Tách người nói, nhập SRT/VTT, chỉnh sửa hoặc khôi phục. Có thể **Lưu phiên bản hiện tại**, xem trước/tìm lời thoại và tên người nói, rồi **Khôi phục phiên bản**. Giữ ghi chú và âm thanh hiện tại; bản đang mở được lưu lại để quay về.
- **Nhập transcript SRT/VTT:** nhấn **Nhập phụ đề** ở khu vực Transcript hoặc **Xuất → Nhập transcript SRT / VTT**. Chọn file, xem trước tên người nói/nội dung/khoảng thời gian rồi **Nhập transcript**. Thay transcript hiện tại, giữ âm thanh và ghi chú, tạo lại tóm tắt/chương. Không cần chạy Whisper.
- **Cắt clip từ transcript:** nhấn biểu tượng kéo ở tab Transcript, chọn đoạn đầu và đoạn cuối (hoặc một đoạn), rồi **Nghe & cắt**. Chỉnh mốc `mm:ss.mmm`, `hh:mm:ss.mmm` hoặc nhập số giây; nghe thử đúng khoảng ở tốc độ 1× và xuất MP3 / WAV PCM 16-bit từ bản gốc hoặc bản đã lọc ồn. Giữ mọi giọng nói và khoảng nghỉ giữa các đoạn đã chọn. Clip dài ít nhất 0,25 giây; có thể huỷ xuất.
- Thêm ghi chú tại vị trí đang nghe; nhấn ghi chú để tua, sửa nội dung trong tab Ghi chú, xoá và hoàn tác. Có nhãn Ý chính / Trích dẫn / Việc cần làm.
- Tab **Tóm tắt** tự chọn câu quan trọng, chia chương và trích ý chính có mốc thời gian. Nhấn timestamp để nghe lại, **Xem đoạn gốc** để đối chiếu, hoặc **Lưu ghi chú** / **Lưu tất cả**. Các ý đã lưu không bị thêm trùng khi nhấn lại.
- Tóm tắt được tạo tự động sau Transcript hoặc Tách người nói. Với các dự án cũ và mẫu, mở tab Tóm tắt → **Tạo tóm tắt**. Sau khi sửa văn bản hoặc gán lại người nói, có cảnh báo cần **Cập nhật tóm tắt**; ghi chú đã lưu được giữ nguyên.
- Lưu nhiều dự án trên ổ đĩa, mở lại từ thư viện. Khi API lưu lỗi, giữ bản nháp trong trình duyệt để thử lại khi mở dự án. Hiện trạng thái lưu rõ ràng.
- Xuất TXT và JSON gồm tóm tắt, chương, ý chính, transcript và ghi chú; SRT / VTT chỉ chứa phụ đề từ transcript. JSON schema 2 có `insights.stale` cho biết tóm tắt có khớp transcript hiện tại hay không. JSON không nhúng audio và hiện chưa có chức năng nhập lại.
- **Xuất báo cáo DOCX / PDF:** nhấn **Xuất**, chọn mẫu **Podcast**, **Bài giảng** hoặc **Phỏng vấn**, rồi chọn định dạng. Báo cáo A4 có tên dự án, file nguồn, thời lượng, ngày nhập/xuất, ngôn ngữ, tóm tắt, chương, ý chính, transcript theo lượt người nói và ghi chú. Các mẫu đổi thứ tự ưu tiên nội dung và giữ đủ các phần.
- Tác vụ có tiến độ, huỷ và thông báo lỗi. Mỗi lúc chỉ chạy một tác vụ AI để tránh quá tải CPU.
- Giao diện responsive, dialog hỗ trợ bàn phím, reduced motion. Space phát/dừng, ←/→ tua 5 giây, Shift + ←/→ tua 15 giây ngoài ô nhập và nút.

## Mẫu và dữ liệu

Mẫu 66 giây có hai giọng tổng hợp Windows David/Zira, tiếng nền tạo bằng FFmpeg, và transcript biên soạn theo từng đoạn. Đây là hội thoại tiếng Anh; giao diện tiếng Việt. Mẫu được ghi rõ trong giao diện. Nút **Chạy AI với mẫu** tạo bản sao riêng rồi thực sự chạy các mô hình, không dùng transcript soạn sẵn.

`npm run demo` tạo lại mẫu trên Windows có hai giọng trên. File mẫu có sẵn nên không cần chạy lệnh này để sử dụng ứng dụng.

Các file cá nhân nằm trong `data/media/`, metadata/transcript/ghi chú trong `data/projects/`, model trong `data/models/`. Các thư mục này không được phục vụ công khai và nằm trong `.gitignore`. Bản mẫu và chỉnh sửa mẫu nằm trong trình duyệt. Giữ thư mục `data/` để mở lại các dự án đã nhập.

Lịch sử nằm cùng file JSON của mỗi dự án để lưu transcript mới và bản khôi phục trong một lần ghi nguyên tử; lỗi ghi giữ nguyên cả hai. Giữ tối đa 20 phiên bản gần nhất trong 64 MiB, loại bản cũ nhất khi vượt giới hạn. Nội dung giống phiên bản gần nhất không tạo thêm bản trùng. Các lần chỉnh sửa liên tiếp được gom theo cửa sổ cố định 5 phút; lưu thủ công, chạy AI, nhập phụ đề và khôi phục kết thúc nhóm chỉnh sửa. Nếu một phiên bản vượt giới hạn, ứng dụng từ chối thay transcript để tránh mất bản khôi phục. Lịch sử không áp dụng cho mẫu `demo`; hãy tạo bản sao riêng trước.

Phiên bản giữ transcript, mốc thời gian, người nói, ngôn ngữ/model và trạng thái nhận diện. Khôi phục giữ tên dự án, ghi chú, mọi file audio và trạng thái lọc ồn đang có; tạo lại tóm tắt và xoá dữ liệu căn từ/lượt nói cũ để lần tách giọng sau dùng văn bản đã khôi phục. Nếu transcript/người nói thay đổi sau khi xem trước, cần **Tải lại** và xem lại trước khi khôi phục. Không lưu/khôi phục trong lúc dự án đang có tác vụ hoặc còn trong hàng đợi chưa hoàn tất. Có thể đọc lịch sử khi đang xử lý. Lịch sử được giữ sau khi khởi động lại máy chủ, chỉ nằm trên máy hiện tại; ZIP sao lưu, ZIP báo cáo và các định dạng xuất chỉ mang phiên bản nội dung hiện tại, không kèm lịch sử cũ. Giữ toàn bộ `data/` nếu cần dự phòng cả lịch sử.

Nhập phụ đề hỗ trợ SRT/WebVTT UTF-8 và UTF-16, tối đa 25 MB, 20.000 đoạn, 5.000 ký tự mỗi đoạn và 20 người nói cho cả dự án. Giữ xuống dòng, đọc nhãn `Tên: lời thoại` (cũng là định dạng xuất của Audio Toolkit) hoặc `<v Tên>` trong WebVTT. Khớp tên với người nói đã có, tạo người nói mới khi cần; đoạn không nhãn dùng người nói đầu tiên hoặc “Người nói 1”. Các cue phải theo thứ tự bắt đầu và nằm trong thời lượng audio; mốc chồng nhau được giữ và báo ở phần xem trước. WebVTT hỗ trợ cue ID, settings và bỏ qua NOTE/STYLE/REGION. Cue chứa nhiều nhãn giọng khác nhau cần tách riêng trước khi nhập để gán người nói đúng.

File lỗi được từ chối trước khi ghi dự án. Nếu transcript/người nói thay đổi sau khi xem trước, phải chọn lại file; ghi chú mới vẫn được giữ. Xem trước hết hạn sau 30 phút hoặc khi khởi động lại máy chủ, và bị bỏ khi đóng dialog; máy chủ chỉ giữ tối đa tám phiên gần nhất trong giới hạn bộ nhớ 50 MB. Import không dùng với mẫu `demo`, dự án đang xử lý hoặc còn trong hàng đợi chưa hoàn tất. Nhãn phụ đề không phải kết quả tách giọng: nhập sẽ xoá dữ liệu căn từ/lượt nói cũ và đặt lại bước Tách người nói. Có thể chạy bước đó sau khi nhập để gán theo âm thanh; văn bản đã nhập được giữ.

ZIP sao lưu dự án khác với ZIP xuất báo cáo: có toàn bộ âm thanh và nhập lại được bằng **Sao lưu & khôi phục**. JSON xuất nội dung và ZIP báo cáo không phải định dạng khôi phục. Sao lưu hoạt động với cả dự án chưa chạy AI và mẫu đang chỉnh sửa trong trình duyệt; mẫu được khôi phục thành dự án riêng. Sao lưu đợi chỉnh sửa lưu thành công và không chạy khi chính dự án đó đang xử lý AI. Mỗi ZIP chứa một dự án, tối đa 1,5 GB; nội dung giải nén được giới hạn theo từng loại file. Đọc ZIP và ghi ZIP theo luồng, âm thanh không cần nạp toàn bộ vào bộ nhớ.

Trước khi khôi phục, máy chủ kiểm tra phiên bản/cấu trúc, kích thước, SHA-256 của metadata và từng file, thời lượng/định dạng audio, mốc thời gian và tham chiếu người nói. Từ chối đường dẫn lạ, file trùng, liên kết, ZIP mã hoá và nội dung vượt giới hạn. Chỉ thêm dự án vào thư viện sau khi audio đã ghi xong; ghi lỗi giữ nguyên các dự án hiện có. Nhập lại cùng snapshot sau khi tải lại trang hoặc khởi động lại máy chủ không tạo trùng. Nếu bản đã khôi phục được chỉnh sửa thêm, mở lại bản đó để giữ công sức mới. Khi chọn bản riêng cho nội dung xung đột, snapshot được lưu dưới mã mới. Không khôi phục tác vụ đang chạy hoặc hàng đợi từ ZIP.

Bản xem trước và link tải tạm hết hạn sau 30 phút hoặc khi máy chủ khởi động lại; tối đa ba bản xem trước và ba link tải gần nhất. Đóng dialog sẽ bỏ bản xem trước. Tạo sao lưu/đọc ZIP có thể huỷ; khi ghi khôi phục, app chờ ghi xong và hỗ trợ thử mở lại nếu thư viện chưa mở được. File ZIP đã tải trong Downloads được giữ nguyên. Dữ liệu tạm trong `data/tmp/backups/` được dọn định kỳ và lúc khởi động. ZIP chứa audio và nội dung đầy đủ, không mã hoá; lưu/chia sẻ ở nơi phù hợp. Model AI không được gói vào ZIP, máy mới cần cài môi trường và model nếu muốn chạy AI tiếp.

Thu âm dùng `getUserMedia` và `MediaRecorder` của trình duyệt, ưu tiên WebM/Opus rồi OGG/Opus hoặc M4A tuỳ hỗ trợ. Chỉ mở micro sau khi nhấn Bắt đầu thu. Khi tạm dừng, micro vẫn mở nhưng không ghi thêm; khi dừng, đóng cửa sổ thu âm hoặc rời trang, các track micro được tắt. Không thu âm hệ thống hay âm thanh tab khác. Cần quyền micro của trình duyệt/Windows và địa chỉ localhost hoặc HTTPS; nếu trình duyệt nhúng không cấp được quyền, mở cùng địa chỉ bằng Chrome/Edge.

Bản thu chưa lưu được giữ trong bộ nhớ của tab, kể cả khi đóng cửa sổ thu âm; mở lại **Thu âm** để tiếp tục nghe và lưu. Bản thu này **không tồn tại sau khi tải lại/đóng tab**: ứng dụng cảnh báo khi rời trang, và có liên kết tải file dự phòng. Lỗi lưu giữ nguyên bản thu để thử lại; nếu lưu đã thành công nhưng mở dự án lỗi, thử mở lại sẽ dùng dự án đã tạo. Cần thu ít nhất 1 giây để lưu; tự dừng gần giới hạn 2 giờ/250 MB. File WebM không có header thời lượng được đo lại từ audio đã giải mã và chuyển thành MP3 có thể tua sau khi lưu. Đồng hồ thu là thời gian thực ước lượng; thời lượng lưu được đo từ âm thanh thực tế.

Clip được tạo bằng FFmpeg trên máy, tải thẳng xuống qua trình duyệt; không sửa audio hay dữ liệu dự án. Bản xuất tạm trong `data/tmp/clips/` và liên kết tải hết hạn sau 30 phút; file đã tải trong Downloads được giữ nguyên. Máy chủ tự dọn file tạm hết hạn mỗi phút và khi khởi động. Xuất clip lần lượt, không chạy cùng tác vụ AI. WAV giữ tần số lấy mẫu và số kênh của nguồn, không nâng chất lượng của nguồn đã nén. Clip chưa có thư viện riêng trong ứng dụng; lịch sử xuất ghi tên file đã tạo.

Báo cáo DOCX/PDF được tạo trong bộ nhớ của máy chủ cục bộ rồi tải qua trình duyệt; không cần API key, kết nối mạng, Word hay LibreOffice để xuất. File không nhúng âm thanh. Báo cáo dùng bản nội dung đang mở, kể cả chỉnh sửa mới nhất, và không thay đổi dự án hoặc tự tạo lại tóm tắt. Nếu tóm tắt cũ, file ghi rõ tóm tắt, chương và ý chính có thể chưa khớp transcript. Nội dung chưa có được ghi rõ, không điền dữ liệu giả.

Hàng đợi dùng chung giữa các tab và được lưu tại `data/queue.json`. **Chờ tải file xong trước khi đóng tab**; khi hiện **Đã lưu trên máy**, các file đã lên máy chủ và xử lý không phụ thuộc trình duyệt. Máy chủ phải tiếp tục chạy; khi máy chủ/máy tính dừng, công việc tạm ngừng và tự tiếp tục sau lần chạy máy chủ tiếp theo. Mỗi dự án có mã cố định và lưu kết quả sau từng bước nên không nhập trùng, không chạy lại file hoàn tất hoặc bước đã lưu. Một bước bị ngắt giữa chừng sẽ chạy lại từ đầu bước đó. File lỗi/đã huỷ chờ người dùng nhấn Thử lại; giữ thiết lập đã dùng cho file đó để khớp các bước trước. Mở lại **Xử lý hàng loạt** để xem hàng đợi đã lưu.

File đang tải chưa xong vẫn cần tab mở; trình duyệt cảnh báo khi rời trang. Nếu bị ngắt, danh sách đã đăng ký hiện **Chọn lại file**: chọn đúng tên và kích thước ban đầu để nối tiếp cùng mục. Những file chưa kịp đăng ký lên máy chủ cần thêm lại. **Huỷ & xoá / Xoá hàng đợi** lưu lệnh huỷ trước khi dừng worker, bỏ danh sách và file tải tạm, giữ nguyên các dự án đã nhập. File tạm trong `data/queue-uploads/` được dọn khi nhập thành công hoặc bỏ hàng đợi. Khi ổ đĩa lỗi/đầy, máy chủ dừng chuyển file và báo lỗi lưu; giải quyết dung lượng/quyền ghi rồi nhấn **Thử lưu lại hàng đợi**. ZIP lấy nội dung mới nhất của các dự án, kể cả bản nháp dự án đang mở.

Các mốc thời gian trong DOCX/PDF là liên kết mở dự án tại vị trí tương ứng, không tự phát âm thanh. Chúng chỉ hoạt động khi Audio Toolkit đang chạy tại cùng cổng và dự án vẫn còn trên máy này; người nhận file ở máy khác vẫn đọc được toàn bộ nội dung. PDF nhúng font Be Vietnam Pro cho tiếng Việt và ký tự Latin, đánh số trang và tự chia nội dung dài. Nếu có ký tự font PDF chưa hỗ trợ (ví dụ chữ Nhật/Trung/Hàn hoặc một số emoji), ứng dụng báo rõ và đề xuất DOCX để tránh mất chữ. DOCX giữ Unicode, dùng Arial và font thay thế của trình đọc. Font PDF được phân phối kèm giấy phép SIL OFL trong `server/fonts/OFL.txt`.

Máy chủ chỉ lắng nghe `127.0.0.1` và chặn yêu cầu ghi từ origin khác. Đây là ứng dụng cá nhân cục bộ; chưa có tài khoản và cách ly nhiều người dùng.

## Model và giới hạn

Lần đầu cần mạng để tải các model công khai từ Hugging Face (Systran/faster-whisper) và GitHub Releases của k2-fsa/sherpa-onnx. Audio và transcript không được gửi ra ngoài. Model giọng nói được kiểm tra SHA-256. Sau khi đã có model đã chọn, các tác vụ chạy được không cần mạng.

Tách người nói ước lượng nhóm giọng, không nhận diện danh tính. Giọng chồng nhau, câu quá ngắn, tiếng nhạc và phòng nhiều vang có thể làm sai nhãn. Cần rà soát trước khi xuất bản. Đặt đúng số người giúp phân cụm ổn định hơn. Lọc nhiễu mạnh có thể làm giọng kém tự nhiên; luôn giữ file gốc. Whisper hiện nhận diện trên bản chuẩn hoá của file gốc để tránh tạo sai lệch giọng do bộ lọc.

Chạy lại Transcript sẽ thay transcript hiện tại. Tách người nói sau khi đã sửa văn bản giữ nguyên văn bản đã sửa và gán mỗi đoạn cho nhóm giọng có thời gian trùng nhiều nhất. Tiến độ tải model và suy luận có thể dừng ở một bước khá lâu trên CPU; không có ETA chính xác.

Tóm tắt chạy hoàn toàn cục bộ bằng TF-IDF, TextRank và chọn câu đa dạng theo chủ đề/người nói; không tải thêm model hoặc gửi transcript ra ngoài. Đây là **tóm tắt trích xuất**, giữ ngôn ngữ và lời văn của transcript. Chương được ước lượng theo khoảng thời gian, thay đổi từ vựng và khoảng nghỉ; tiêu đề trích từ một đoạn đại diện. Hệ thống chưa viết lại thành văn xuôi, dịch hoặc suy luận việc cần làm. Chất lượng phụ thuộc transcript; nội dung rất ngắn, ít dấu câu hoặc đổi chủ đề không rõ có thể cần rà soát. Mốc ý chính là mốc của đoạn transcript gốc, không ước lượng lại thời gian từng từ.

Biến môi trường tuỳ chọn: `PORT` (mặc định 4188), `AUDIO_PYTHON` (đường dẫn Python có thư viện), `AUDIO_MODEL_CACHE` (thư mục cache Whisper), `AUDIO_DATA_DIR` (thư mục dữ liệu riêng, mặc định `data/`; dùng khi kiểm thử cách ly). Thông thường không cần đặt.

## Kiểm tra

```powershell
npm test
.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py" -v
npm audit
node scripts/smoke.mjs
node scripts/smoke.mjs --ai
node scripts/smoke-insights.mjs
node scripts/smoke-insights.mjs --transcribe
node scripts/smoke-clips.mjs
node scripts/smoke-recordings.mjs
node scripts/smoke-reports.mjs
node scripts/smoke-batch.mjs
node scripts/smoke-batch.mjs --ai
node scripts/smoke-queue-restart.mjs
node scripts/smoke-backups.mjs
node scripts/smoke-subtitles.mjs
node scripts/smoke-history.mjs
node scripts/smoke-history.mjs --ai
```

Smoke cần API đang chạy và tạo một dự án thử trong `data/`. Phiên bản AI chạy trên file mẫu thật, kiểm tra transcript không rỗng, hai nhóm giọng, thứ tự và biên thời gian, ghi chú tiếng Việt được giữ, audio MP3 xuất có thời lượng đúng, hỗ trợ HTTP Range và chặn origin ngoài. Test đơn vị kiểm tra thời gian không hợp lệ, tham chiếu speaker, Unicode, im lặng và việc chia đoạn theo giọng.

Kiểm tra tóm tắt gồm truy vết văn bản/mốc thời gian về nguồn, loại câu trùng, chương phủ bản thu, dữ liệu tiếng Việt, transcript dài 2 giờ, phát hiện tóm tắt cũ và nội dung TXT/JSON. Smoke tóm tắt kiểm tra API lưu/đọc lại, giữ ghi chú cũ, từ chối transcript đã thay đổi và origin ngoài; cờ `--transcribe` chạy Whisper thật để xác nhận tạo tóm tắt tự động sau nhận diện.

Kiểm tra clip gồm mốc đến mili giây, chọn ngược chiều/đoạn chồng nhau, giới hạn thời gian và định dạng. Smoke clip dùng mẫu có sẵn, đối chiếu từng mẫu PCM của WAV với nguồn, đo thời lượng MP3/WAV ở đầu/cuối bản thu và khoảng ngắn nhất, tải qua HTTP Range, giữ nguyên dữ liệu dự án, từ chối nguồn ngoài và xuất đồng thời, huỷ FFmpeg và dọn file đang xuất. Không chạy lại các mô hình AI.

Kiểm tra thu âm gồm tính giờ bỏ qua tạm dừng, dữ liệu cuối sau khi dừng, tắt track, từ chối quyền, huỷ yêu cầu micro chưa hoàn tất, ngắt thiết bị, giới hạn và thu lại. Smoke tạo WebM streaming không có header thời lượng để kiểm tra nhập, waveform, thời lượng phát, giữ nguyên file gốc, từ chối file ngắn/lỗi. Có thể truyền đường dẫn WebM từ MediaRecorder thật vào `node scripts/smoke-recordings.mjs "đường-dẫn-file.webm"`.

Kiểm tra báo cáo gồm Unicode tiếng Việt, giữ xuống dòng và tên người nói, thứ tự hội thoại, ba mẫu, liên kết timestamp, cảnh báo tóm tắt cũ, nội dung trống và PDF nhiều trang không thêm trang trắng do footer. Smoke báo cáo tải DOCX/PDF qua API vào `data/checks/reports/`, kiểm tra MIME/tên tải, bản nội dung hiện tại và bản đã lưu, dữ liệu không hợp lệ, origin ngoài và giữ nguyên dự án. Bố cục PDF được rà trực quan bằng Poppler; DOCX được mở/kiểm tra OOXML và nội dung. Môi trường kiểm thử hiện thiếu LibreOffice nên chưa xác nhận bố cục DOCX bằng công cụ render.

Kiểm tra hàng loạt gồm tuần tự, tiếp tục sau lỗi, đăng ký/tải lại không trùng, khôi phục tác vụ đang nhập/xử lý, huỷ bền vững, hàng đợi dùng chung giữa các tab, chờ máy bận, file tải dở, snapshot cũ, lỗi ghi đĩa và JSON hỏng. Có test Windows dừng cả tiến trình con của Python launcher. Kiểm tra ZIP đủ sáu định dạng, Unicode, tên trùng, đường dẫn an toàn và dữ liệu không hợp lệ. Smoke batch cắt hai đoạn âm thanh thật từ mẫu và chạy cùng lớp điều khiển của giao diện: mặc định lọc ồn; `--ai` chạy đủ ba bước với Whisper tiny và một người nói. Xuất ZIP qua API, đối chiếu manifest/nội dung/header, từ chối origin ngoài và kiểm tra không sửa dữ liệu dự án. Kết quả ở `data/checks/batch/`.

`smoke-queue-restart.mjs` tự mở máy chủ trên cổng riêng và thư mục `data/checks/queue-restart-…/`, dùng lại cache model đã cài. Chạy hai file thật mà không có browser điều phối, dừng đột ngột cả cây máy chủ/Python sau khi file đầu xong và file sau đã lọc ồn, rồi mở lại. Đối chiếu file dự án đầu không đổi, thời gian/hash MP3 đã lọc không đổi, số dự án không tăng và transcript/người nói thực vẫn hoàn tất. Kiểm tra thêm file tải dở sau restart, origin ngoài và xoá hàng đợi giữ nguyên dự án. Không dừng máy chủ chính hay sửa hàng đợi của người dùng. Cần cache Whisper tiny và model người nói đã tải để chạy smoke offline này.

Kiểm tra sao lưu gồm round trip giữ đúng byte audio, tiếng Việt/xuống dòng/mốc thời gian, từ/lượt nói của AI, dự án chưa lọc và mẫu, trùng/xung đột, nhập đồng thời, thử lại sau lỗi ghi, thay đổi sau lúc xem trước, hết hạn và dọn file tạm. Kiểm tra ZIP hỏng, hash sai, thiếu/thừa file, phiên bản lạ, đường dẫn thoát thư mục, symlink, mục trùng và kích thước giải nén giả. `smoke-backups.mjs` mở máy chủ/cổng và dữ liệu cách ly ở `data/checks/backup-…/`, sao lưu/khôi phục âm thanh thật, đối chiếu byte và metadata, phát/HTTP Range, kiểm tra không ghi đè và nhập lại sau restart. Từ chối cả nội dung không phải âm thanh dù manifest/hash tự khớp, đồng thời kiểm tra origin ngoài. Không chạy AI lại và không sửa dự án của máy chủ chính.

Kiểm tra phụ đề gồm SRT/WebVTT, BOM/UTF-16, timestamp, nhãn giọng, tiếng Việt/xuống dòng/entities, cue chồng nhau, giới hạn nội dung, dự án không bị sửa khi lỗi, xung đột sau preview, thử lưu lại và phiên hết hạn. `smoke-subtitles.mjs` mở máy chủ và dữ liệu cách ly tại `data/checks/subtitles-…/`, chạy preview → import → xuất lại, giữ ghi chú/audio, làm mới tóm tắt, xoá căn từ cũ, chặn dự án trong hàng đợi, kiểm tra upload lỗi/quá lớn được dọn và transcript tồn tại sau restart. Không chạy lại AI và không sửa dự án của máy chủ chính.

Kiểm tra lịch sử gồm snapshot độc lập, gom chỉnh sửa/khử trùng, giới hạn số bản/dung lượng, nội dung hỏng, preview cũ, khôi phục đảo ngược được và lỗi ghi nguyên tử. `smoke-history.mjs` mở máy chủ/cổng với dữ liệu cách ly tại `data/checks/history-…/`, kiểm tra lưu thủ công → sửa → nhập phụ đề → khôi phục → quay về bản trước, giữ byte audio và ghi chú, làm mới tóm tắt, chặn hàng đợi/origin ngoài và tồn tại sau restart. Mặc định kiểm tra checkpoint trước AI rồi huỷ; `--ai` chạy Whisper tiny thực và khôi phục bản trước khi chạy. Không sửa dự án của máy chủ chính.

Để kiểm tra UI mà không dùng micro thật: chạy `node scripts/recording-fixture.mjs`, mở `http://127.0.0.1:4188/recording-check.html`. Trang dùng MediaRecorder thật với tín hiệu sin tổng hợp, chỉ phát ra loa khi nhấn nghe lại; có công tắc giả lập lỗi lưu/mở. Kiểm tra thu, tạm dừng/tiếp tục, đóng/mở giữ bản thu, nghe lại/tải file, thử lưu lại và không tạo trùng dự án. Chạy `node scripts/recording-fixture.mjs --remove` sau khi xong để xoá hai file trang kiểm tra tạm.

AI đã được kiểm tra trên mẫu tổng hợp tiếng Anh hai giọng; chưa đánh giá độ chính xác trên tập thu âm tiếng Việt thực tế.
