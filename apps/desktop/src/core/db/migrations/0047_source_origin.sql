-- 源的归属与分享信息（契约 §68）：
--   origin              'mine' = 我自己的电脑（本机、配对、用自己的账号挂上）；
--                       'shared' = 别人经分享链接给我的（sources.mountByLink）。
--   owner_label         分享方报的主人名字（cloud/login 的 share.ownerName）；mine 为空串。
--   share_role          分享给我的角色（viewer / editor / operator / driver）；空串 = 未知或 mine。
--   share_expires_at_ms 分享到期的时刻；0 = 未知、不过期或 mine。
-- 都是展示用的提示：权限由分享方的 core 判定，这里不参与任何授权。
ALTER TABLE client_sources ADD COLUMN origin TEXT NOT NULL DEFAULT 'mine' CHECK(origin IN ('mine', 'shared'));
ALTER TABLE client_sources ADD COLUMN owner_label TEXT NOT NULL DEFAULT '' CHECK(length(owner_label) <= 128);
ALTER TABLE client_sources ADD COLUMN share_role TEXT NOT NULL DEFAULT ''
  CHECK(share_role IN ('', 'viewer', 'editor', 'operator', 'driver'));
ALTER TABLE client_sources ADD COLUMN share_expires_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(share_expires_at_ms >= 0);

-- 回填：按链接加入的源只有经访客远程服务（account_hint 为空，mountByLink 建的那一行）
-- 的中继路——没有直连路、没有经登录账号的中继路、至少一条经访客服务的中继路。
-- 其余（本机、配对、用账号挂上的）留 'mine'。
UPDATE client_sources SET origin = 'shared'
WHERE kind IN ('direct', 'relayed')
  AND NOT EXISTS (
    SELECT 1 FROM client_source_routes r
    WHERE r.source_id = client_sources.source_id AND r.via = 'direct')
  AND EXISTS (
    SELECT 1 FROM client_source_routes r JOIN remote_services s ON s.issuer = r.cloud_issuer
    WHERE r.source_id = client_sources.source_id AND r.via = 'relayed' AND s.account_hint = '')
  AND NOT EXISTS (
    SELECT 1 FROM client_source_routes r JOIN remote_services s ON s.issuer = r.cloud_issuer
    WHERE r.source_id = client_sources.source_id AND r.via = 'relayed' AND s.account_hint <> '');
