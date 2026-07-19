// usage: swift merge-pdf.swift out.pdf in1.pdf in2.pdf ...
// 각 입력 PDF의 "1페이지만" 취해 병합 (Chrome 서브픽셀 스필로 생기는 트레일링 빈 페이지 방지)
import Foundation
import PDFKit

let args = CommandLine.arguments
let out = PDFDocument()
for (i, path) in args.dropFirst(2).enumerated() {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: path)), let page = doc.page(at: 0) else {
        print("FAIL reading \(path)"); exit(1)
    }
    out.insert(page, at: i)
}
guard out.write(to: URL(fileURLWithPath: args[1])) else { print("FAIL writing"); exit(1) }
print("merged \(out.pageCount) pages -> \(args[1])")
