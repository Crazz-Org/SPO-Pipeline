# Invariants — task 462

Facts about the existing code the plan depends on: the six emitting call sites, whose files IMPLEMENT does not touch. Each quote pins the call shape (verb and argument count) that the catalogue comment will cite.

## INV-1
File: src/server/session/login-handler.ts:194
>>> QUOTE
    const sessionPacket = await sendDirectoryRequest(ctx, 'directory_auth',rdoGet('RDOOpenSession', directoryServerId).packet);
>>> END QUOTE

## INV-2
File: src/server/session/login-handler.ts:202-206
>>> QUOTE
    const logonPacket = await sendDirectoryRequest(ctx, 'directory_auth',rdoCall(
      'RDOLogonUser', sessionId,
      RdoValue.string(username),
      RdoValue.string(pass),
    ).packet);
>>> END QUOTE

## INV-3
File: src/server/session/login-handler.ts:215
>>> QUOTE
    writeRdoFrame(socket, rdoCall('RDOEndSession', sessionId).toFrame());
>>> END QUOTE

## INV-4
File: src/server/session/login-handler.ts:308-311
>>> QUOTE
      const setKeyPacket = await sendDirectoryRequest(ctx, 'directory_search',rdoCall(
        'RDOSetCurrentKey', sessionId,
        RdoValue.string(`${USERS_KEY}/${letter}`),
      ).packet);
>>> END QUOTE

## INV-5
File: src/server/session/login-handler.ts:323-327
>>> QUOTE
      const searchPacket = await sendDirectoryRequest(ctx, 'directory_search',rdoCall(
        'RDOSearchKey', sessionId,
        RdoValue.string(pattern),
        RdoValue.string(SEARCH_VALUE_NAMES),
      ).packet);
>>> END QUOTE

## INV-6
File: src/server/spo_session.ts:997
>>> QUOTE
      const logonCmd = rdoCall('RDOLogonClient', this.worldId, RdoValue.string(loginUser), RdoValue.string(this.cachedPassword!)).toFrame();
>>> END QUOTE
