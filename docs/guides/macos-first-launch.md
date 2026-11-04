# macOS 首次打开

官方 macOS 安装包目前是 **ad-hoc 签名，未经 Apple 公证**（Developer ID 签名与公证推迟到公开发布，见 [#750](https://github.com/AMA-Link/Armadra/issues/750)）。系统因此会在第一次打开时拦下它，需要你确认一次；确认之后和普通应用一样使用。

## macOS 15 及更新

1. 把 `Armadra.app` 拖进「应用程序」，双击打开一次，系统提示无法验证并拦下。
2. 打开「系统设置 → 隐私与安全性」，滚到「安全性」，在 Armadra 的提示旁点「仍要打开」。
3. 输入登录密码或使用触控 ID 确认，再点「打开」。

macOS 15 起，旧的「右键 → 打开」绕过方式不再有效，必须走上面的「仍要打开」。

## 用终端去掉隔离标记

不想点设置时，在终端执行下面一行，之后可直接双击打开：

```sh
xattr -dr com.apple.quarantine /Applications/Armadra.app
```

## 通过 Homebrew 安装

```sh
brew install --cask armadra
```

cask 只负责下载并放进「应用程序」，不会去掉隔离标记，所以装完仍要按上面任一种方式确认一次。升级后同理。

## 更新

ad-hoc 签名的包不被系统的更新机制接受：应用内的更新可以检查并下载，但不会自动替换应用。更新时下载新版安装包（或 `brew upgrade --cask armadra`），覆盖「应用程序」里的旧版，再按上面任一种方式确认一次。数据目录不受影响。
