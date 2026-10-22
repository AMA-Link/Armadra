-- SaaS 准入后每个人在团队里的角色（契约 §60.4）：断言 `team.role` 每次登录整行覆盖，断言不带 `team` 时删掉。
-- 设备背书（`devices.approve`）按它判：团队 owner / admin 可以背书别人的新设备，成员只能背书自己的。
-- 重启之后会话还在，所以要落盘；断言原文不落盘，这里只留 teamId 与角色。
CREATE TABLE cloud_team_roles (
  principal_id TEXT NOT NULL CHECK(length(principal_id) BETWEEN 1 AND 128),
  provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 128),
  team_id TEXT NOT NULL CHECK(length(team_id) BETWEEN 1 AND 128),
  role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member', 'billing', 'guest')),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
  PRIMARY KEY (principal_id, provider)
);
