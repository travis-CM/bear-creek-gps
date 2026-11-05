import SwiftUI
import WebKit
import UIKit

struct WebContainer: UIViewRepresentable {
    let bridge: Bridge
    static let home = URL(string: "https://travis-cm.github.io/bear-creek-gps/?native=1")!

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(bridge, name: "bcgps")
        cfg.websiteDataStore = .default()
        cfg.allowsInlineMediaPlayback = true
        cfg.limitsNavigationsToAppBoundDomains = true
        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.isOpaque = false
        wv.backgroundColor = UIColor(red: 0.06, green: 0.08, blue: 0.07, alpha: 1)
        wv.scrollView.backgroundColor = wv.backgroundColor
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.scrollView.bounces = false
        wv.allowsBackForwardNavigationGestures = false
        wv.navigationDelegate = context.coordinator
        wv.uiDelegate = context.coordinator
        bridge.webView = wv
        wv.load(URLRequest(url: WebContainer.home))
        return wv
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        // Links that leave the app (club website, tee times, phone numbers) open in Safari / Phone.
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { decisionHandler(.allow); return }
            let scheme = url.scheme ?? ""
            if ["about", "blob", "data"].contains(scheme) || (scheme == "https" && url.host == "travis-cm.github.io") {
                decisionHandler(.allow)
            } else {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
            }
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url, url.scheme != "data" { UIApplication.shared.open(url) }
            return nil
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { webView.load(URLRequest(url: WebContainer.home)) }
        }

        // JavaScript alert() / confirm() used by the web app
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            present(a, from: webView, orElse: completionHandler)
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
            a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
            present(a, from: webView, orElse: { completionHandler(false) })
        }

        private func present(_ alert: UIAlertController, from view: UIView, orElse fallback: @escaping () -> Void) {
            var top = view.window?.rootViewController
            while let p = top?.presentedViewController { top = p }
            if let top = top { top.present(alert, animated: true) } else { fallback() }
        }
    }
}
