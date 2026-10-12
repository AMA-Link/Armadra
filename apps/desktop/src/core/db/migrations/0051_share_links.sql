-- 分享链接在 core 这一侧的记录（契约 §80）：远程服务管链接本身（秘密、计次、撤销），
-- 这里记它背后的邀请、访客设备的名额与链接片段里给出的身份指纹前缀。
--
--   max_devices        经这条链接绑定的访客设备钥最多几把；NULL = 不限（缺省等于 maxUses）。
--   identity_fp_shown  链接片段第三段（core 身份公钥指纹前 16 位），访客据此钉扎。
CREATE TABLE share_links (
  link_id TEXT PRIMARY KEY CHECK(length(link_id) BETWEEN 1 AND 128),
  issuer TEXT NOT NULL CHECK(length(issuer) <= 512),
  invitation_id TEXT NOT NULL CHECK(length(invitation_id) <= 64),
  max_devices INTEGER CHECK(max_devices IS NULL OR max_devices >= 0),
  identity_fp_shown TEXT NOT NULL DEFAULT '' CHECK(length(identity_fp_shown) <= 64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
  revoked_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(revoked_at_ms >= 0)
) WITHOUT ROWID;
