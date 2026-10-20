import type { Metadata } from "next";
import "./style.css";

export const metadata: Metadata = {
  title: "Mirai · Local voice check",
  description: "TASK-003A local microphone and provider readiness foundation"
};

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
