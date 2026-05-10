// 头像动画套装配置 — 每套包含 idle（静止）和 speaking（说话）两个 CDN URL
export interface AvatarSet {
  name: string;
  idle: string;
  speaking: string;
}

export const avatarSets: AvatarSet[] = [
  {
    name: "默认",
    idle: "/src/assets/webp/hlw1.webp",
    speaking: "/src/assets/webp/hlw2.webp",
  },
  // 添加更多 CDN 动画套装：
  // {
  //   name: "套装2",
  //   idle: "https://cdn.example.com/avatar2-idle.webp",
  //   speaking: "https://cdn.example.com/avatar2-speaking.webp",
  // },
];

export const AVATAR_STORAGE_KEY = "xiaozhi_avatar_index";
