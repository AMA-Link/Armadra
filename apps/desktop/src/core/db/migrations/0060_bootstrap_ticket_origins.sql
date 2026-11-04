-- 配对票绑定 Gateway 的来源集合（契约 §99.3，#749）：换行分隔的来源列表，
-- 空串 = 只认 `origin` 一个（旧票）。兑换时请求来源在集合里即可，会话绑定实际来的那个。
ALTER TABLE identity_bootstrap_tickets ADD COLUMN origins TEXT NOT NULL DEFAULT '';
