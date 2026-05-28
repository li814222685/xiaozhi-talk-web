// 头像动画套装配置 — 每套包含 idle（静止）和 speaking（说话）两个 CDN URL
import hlw1 from "@/assets/webp/hlw1.webp";
import hlw2 from "@/assets/webp/hlw2.webp";

export interface AvatarSet {
  name: string;
  idle: string;
  speaking: string;
}

export const avatarSets: AvatarSet[] = [
  {
    name: "默认",
    idle: hlw1,
    speaking: hlw2,
  },
  // 添加更多 CDN 动画套装：
  // {
  //   name: "套装2",
  //   idle: "https://cdn.example.com/avatar2-idle.webp",
  //   speaking: "https://cdn.example.com/avatar2-speaking.webp",
  // },
];

export const AVATAR_STORAGE_KEY = "xiaozhi_avatar_index";
