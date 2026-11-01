import { NEW_API_PROVIDER_ID, type OAuthSessionState, type UserInfo } from "@zcode/shared";
import { User } from "lucide-react";
import { useEffect, useState, type ComponentType } from "react";
import { ProfileAvatarFallbackProvider } from "@/profile-avatar/index.js";
import type { AiscooAccountAvatarProps, AiscooAccountAvatarProviderProps } from "./contract.js";
import { getAccountAvatarDataUri } from "./generator.js";

function GeneratedAccountAvatar(props: { src: string | null; label: string }) {
  const [failed, setFailed] = useState(false);
  if (!props.src || failed) {
    return <User className="size-4" role="img" aria-label={props.label} />;
  }
  return (
    <img
      src={props.src}
      alt={props.label}
      className="size-full rounded-full object-cover"
      onError={() => setFailed(true)}
    />
  );
}

export function AiscooAccountAvatar(props: AiscooAccountAvatarProps) {
  const src = getAccountAvatarDataUri(props.userId);
  // 不同身份可能生成相同图案；按身份和地址重置失败状态，避免换号后继承旧错误。
  return (
    <GeneratedAccountAvatar
      key={JSON.stringify([props.userId, src])}
      src={src}
      label={props.label}
    />
  );
}

function renderAccountAvatar(user: UserInfo) {
  // 未知 provider 的非数字 ID 原本使用首字回退，不能被误认作 New API 身份。
  if (user.id.trim() && !/^[1-9]\d*$/u.test(user.id.trim())) return null;
  return (
    <AiscooAccountAvatar
      userId={user.id}
      label={user.displayName.trim() || user.username.trim() || user.id}
    />
  );
}

export function AiscooAccountAvatarProvider(props: AiscooAccountAvatarProviderProps) {
  return (
    <ProfileAvatarFallbackProvider renderFallback={renderAccountAvatar}>
      {props.children}
    </ProfileAvatarFallbackProvider>
  );
}

type AvatarOAuthService = {
  getProviders(): Promise<readonly { id: string }[]>;
  getActiveProvider(): Promise<string | null>;
  onDidChangeSession(listener: (state: OAuthSessionState) => void): { dispose(): void };
};

type RootWithOAuth = { services: { oauthService: AvatarOAuthService } };

export function createAiscooAccountAvatarRoot<Props extends RootWithOAuth>(
  Root: ComponentType<Props>,
) {
  return function AiscooAccountAvatarRoot(props: Props) {
    const service = props.services.oauthService;
    const [confirmedService, setConfirmedService] = useState<AvatarOAuthService | null>(null);
    useEffect(() => {
      let alive = true;
      let generation = 0;
      const refresh = (event?: OAuthSessionState) => {
        const request = ++generation;
        setConfirmedService(null);
        // 退出事件是权威失效信号，不能因迟到的旧 active 查询重新启用头像。
        if (event === "signed-out") return;
        void (async () => {
          try {
            const providers = await service.getProviders();
            if (providers.length !== 1 || providers[0]?.id !== NEW_API_PROVIDER_ID) return;
            const active = await service.getActiveProvider();
            if (alive && generation === request && active === NEW_API_PROVIDER_ID)
              setConfirmedService(service);
          } catch {
            // 读取失败时不能推断身份，保持上游 fallback。
          }
        })();
      };
      // 先订阅以覆盖查询期间的退出与换号；旧请求不得提交到新身份。
      let subscription: { dispose(): void };
      try {
        subscription = service.onDidChangeSession(refresh);
      } catch {
        // 订阅不可用时无法防止过期身份，保留上游 fallback。
        setConfirmedService(null);
        return () => {
          alive = false;
          generation++;
        };
      }
      refresh();
      return () => {
        alive = false;
        generation++;
        subscription.dispose();
      };
    }, [service]);
    // 不能切换根组件的父节点，否则确认或失效身份会重挂整棵应用并丢失本地状态。
    return (
      <ProfileAvatarFallbackProvider
        renderFallback={confirmedService === service ? renderAccountAvatar : () => null}
      >
        <Root {...props} />
      </ProfileAvatarFallbackProvider>
    );
  };
}
