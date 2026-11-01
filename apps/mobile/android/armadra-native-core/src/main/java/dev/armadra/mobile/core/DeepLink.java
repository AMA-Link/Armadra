package dev.armadra.mobile.core;

import java.util.regex.Pattern;

/**
 * 原生收到的三种深链与交给页面的那一行 JS（与 iOS {@code DeepLink.swift} 同义）：
 *
 * <ul>
 *   <li>{@code armadra://pair?…}：写进 {@code #link=} 再重载，连接页拿它当初值，人点「连接」才配；
 *   <li>{@code armadra://join?link=<id>&issuer=<签发方>&s=<片段>}：个人中转的分享链接（cloud 契约 §10），与配对一样
 *       写进 {@code #link=} 再重载，连接页收到就直接挂载；
 *   <li>{@code armadra://w/<工作空间>[/n/<节点>][?s=<源>]}：写进 {@code #push=}，页面认 {@code hashchange}
 *       （{@code s} 是签发通知的主机，契约 §19.4，连着别的主机时页面自己切）；
 *   <li>{@code armadra://oauth?state=…&code=…}（或 {@code error=}）：原生 OAuth 的回调（R-56），与配对一样
 *       写进 {@code #link=} 再重载，入口在挂载前收尾；
 *   <li>{@code armadra://cloud/device-approved}：控制台批准页在浏览器里批准了手机的设备码登录后带人回来
 *       （#666）。只让 App 回前台并通知页面（插件事件 {@code cloudDeviceApproved}），不写 {@code #link=}、不重载——
 *       重载会丢掉只在内存里的设备码；冷启动带着它当普通启动。不带任何参数或秘密。
 * </ul>
 *
 * 其余一律不认；链接按 JSON 字符串字面量嵌进脚本。
 */
public final class DeepLink {
    public enum Kind { PAIR, JOIN, NODE, OAUTH, CLOUD_DEVICE_APPROVED }

    private static final int MAX_LENGTH = 2048;
    private static final Pattern PAIR = Pattern.compile("^armadra://pair\\?[A-Za-z0-9._~%&=:+-]+$");
    private static final Pattern JOIN = Pattern.compile("^armadra://join\\?[A-Za-z0-9._~%&=:+-]+$");
    private static final Pattern OAUTH = Pattern.compile("^armadra://oauth\\?[A-Za-z0-9._~%&=:+*-]+$");
    private static final Pattern CLOUD_DEVICE_APPROVED = Pattern.compile("^armadra://cloud/device-approved/?$");
    private static final Pattern NODE =
            Pattern.compile("^armadra://w/[A-Za-z0-9._~%-]+(/n/[A-Za-z0-9._~%-]+)?/?(\\?s=[A-Za-z0-9._~%-]+)?$");

    public final Kind kind;
    public final String link;

    private DeepLink(Kind kind, String link) {
        this.kind = kind;
        this.link = link;
    }

    /** 认不出是 {@code null}。 */
    public static DeepLink parse(String link) {
        if (link == null || link.length() > MAX_LENGTH) return null;
        if (PAIR.matcher(link).matches()) return new DeepLink(Kind.PAIR, link);
        if (JOIN.matcher(link).matches()) return new DeepLink(Kind.JOIN, link);
        if (NODE.matcher(link).matches()) return new DeepLink(Kind.NODE, link);
        if (OAUTH.matcher(link).matches()) return new DeepLink(Kind.OAUTH, link);
        if (CLOUD_DEVICE_APPROVED.matcher(link).matches()) return new DeepLink(Kind.CLOUD_DEVICE_APPROVED, link);
        return null;
    }

    /** 只通知页面（插件事件），没有要在页面里执行的脚本：{@link #script()} 对它答 {@code null}。 */
    public boolean notifiesOnly() {
        return kind == Kind.CLOUD_DEVICE_APPROVED;
    }

    /** 在页面里执行的那一行；{@link #notifiesOnly()} 的那种没有，是 {@code null}。 */
    public String script() {
        if (notifiesOnly()) return null;
        String literal = literal(link);
        if (kind == Kind.PAIR || kind == Kind.JOIN || kind == Kind.OAUTH) {
            return "history.replaceState(null,'',location.pathname+'#link='+encodeURIComponent("
                    + literal + "));location.reload();";
        }
        return "location.hash='#push='+encodeURIComponent(" + literal + ");";
    }

    static String literal(String text) {
        StringBuilder out = new StringBuilder(text.length() + 2).append('"');
        for (int index = 0; index < text.length(); index++) {
            char c = text.charAt(index);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '/': out.append("\\/"); break;
                default:
                    if (c < 0x20 || c == (char) 0x2028 || c == (char) 0x2029) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
            }
        }
        return out.append('"').toString();
    }
}
