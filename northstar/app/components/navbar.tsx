"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { href: "/", label: "Calendar" },
  { href: "/xmanager", label: "X Manager" },
  { href: "/settings", label: "Settings" },
];

export function Navbar() {
  const pathname = usePathname();

  return (
    <header className="border-b border-neutral-200 dark:border-neutral-800">
      <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Northstar</h1>
        <nav className="flex items-center gap-1">
          {navItems.map((item) => {
            const isActive = item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                  isActive
                    ? "bg-neutral-100 dark:bg-neutral-800 text-foreground font-medium"
                    : "text-neutral-600 dark:text-neutral-400 hover:text-foreground hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
