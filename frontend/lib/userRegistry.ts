type UserRegistryResponse = {
  ok?: boolean;
  phone?: string;
  registered?: boolean;
  registeredAt?: number;
  detail?: string;
  message?: string;
};

async function postUserRegistry(
  path: "/api/users/register" | "/api/users/exists",
  phone: string,
): Promise<UserRegistryResponse> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone }),
  });

  const data = (await res.json()) as UserRegistryResponse;
  if (!res.ok) {
    return {
      ok: false,
      message: data.message ?? data.detail ?? "User registry request failed",
    };
  }

  return data;
}

export async function registerUser(phone: string): Promise<{
  ok: boolean;
  phone?: string;
  registeredAt?: number;
  message?: string;
}> {
  const data = await postUserRegistry("/api/users/register", phone);
  return {
    ok: data.ok === true,
    phone: data.phone,
    registeredAt: data.registeredAt,
    message: data.message,
  };
}

export async function isRegisteredUser(phone: string): Promise<{
  ok: boolean;
  phone?: string;
  registered: boolean;
  message?: string;
}> {
  const data = await postUserRegistry("/api/users/exists", phone);
  return {
    ok: data.ok === true,
    phone: data.phone,
    registered: data.registered === true,
    message: data.message,
  };
}
