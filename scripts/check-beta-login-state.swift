import AppKit
import CoreGraphics
import Foundation
import Security
var ref: SecKeychain?
if SecKeychainCopyDefault(&ref) == errSecSuccess, let ref {
    var flags: SecKeychainStatus = 0
    let result = SecKeychainGetStatus(ref, &flags)
    print("Default keychain status available:", result == errSecSuccess, "unlocked:", flags & 1 != 0)
}
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let systemAgents: Set<String> = ["SecurityAgent","SecurityAgentService","CoreServicesUIAgent","LocalAuthenticationRemoteService","UserNotificationCenter"]
for window in windows {
    guard let owner = window[kCGWindowOwnerName as String] as? String, systemAgents.contains(owner) else { continue }
    print("Visible macOS system dialog owner:", owner)
}
let requested: [String:Any] = [kSecClass as String:kSecClassGenericPassword, kSecAttrService as String:"PutmanCode Safe Storage", kSecReturnAttributes as String:true, kSecMatchLimit as String:kSecMatchLimitOne, kSecUseAuthenticationUI as String:kSecUseAuthenticationUIFail]
let status=SecItemCopyMatching(requested as CFDictionary,nil)
print("App storage item metadata status:", status)
