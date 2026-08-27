FROM mcr.microsoft.com/dotnet/aspnet:8.0.2-jammy AS runtime
WORKDIR /app

FROM mcr.microsoft.com/dotnet/sdk:8.0.201-jammy AS build
WORKDIR /src
COPY . .
RUN dotnet publish Ledger.Api.csproj -c Release -o /out

FROM runtime AS final
COPY --from=build /out .
ENTRYPOINT ["dotnet", "Ledger.Api.dll"]
