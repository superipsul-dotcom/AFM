// macOS Vision 프레임워크로 인물 배경 제거 (사진앱 '배경 제거'와 동일 엔진)
// 사용: swift remove-bg.swift <입력.png> <출력.png>
import Vision
import AppKit
import CoreImage

let args = CommandLine.arguments
guard args.count == 3 else { fatalError("usage: swift remove-bg.swift in.png out.png") }
let inURL = URL(fileURLWithPath: args[1])
let outURL = URL(fileURLWithPath: args[2])

let handler = VNImageRequestHandler(url: inURL)
let request = VNGenerateForegroundInstanceMaskRequest()
try handler.perform([request])
guard let result = request.results?.first else { fatalError("no foreground instances found") }

let buffer = try result.generateMaskedImage(
  ofInstances: result.allInstances,
  from: handler,
  croppedToInstancesExtent: false
)

let ciImage = CIImage(cvPixelBuffer: buffer)
let context = CIContext()
guard let cgImage = context.createCGImage(ciImage, from: ciImage.extent) else { fatalError("cg fail") }
let rep = NSBitmapImageRep(cgImage: cgImage)
guard let png = rep.representation(using: .png, properties: [:]) else { fatalError("png fail") }
try png.write(to: outURL)
print("saved \(outURL.path)")
