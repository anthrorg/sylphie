import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  UseGuards,
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@sylphie/shared';
import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';
import { AuthGuard, JwtPayload } from '../guards/auth.guard';

@Controller('auth')
export class AuthController {
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {}

  @Post('register')
  async register(@Body() body: { username: string; password: string }) {
    const existing = await this.prisma.user.findUnique({
      where: { username: body.username },
    });
    if (existing) {
      throw new BadRequestException('Username already taken');
    }

    const passwordHash = await bcrypt.hash(body.password, 10);
    const user = await this.prisma.user.create({
      data: { username: body.username, passwordHash },
    });

    return {
      user: { id: user.id, username: user.username },
      message: 'Account created. An administrator must approve your account before you can log in.',
    };
  }

  @Post('login')
  async login(@Body() body: { username: string; password: string }) {
    const user = await this.prisma.user.findUnique({
      where: { username: body.username },
    });
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await bcrypt.compare(body.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.approved) {
      throw new ForbiddenException('Account pending approval');
    }

    const token = this.signToken({ sub: user.id, username: user.username, isGuardian: user.isGuardian });
    return {
      user: { id: user.id, username: user.username, isGuardian: user.isGuardian },
      token,
    };
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@Req() req: { user: JwtPayload }) {
    return { id: req.user.sub, username: req.user.username, isGuardian: req.user.isGuardian ?? false };
  }

  private signToken(payload: JwtPayload): string {
    const secret = this.configService.get<string>('JWT_SECRET')!;
    return jwt.sign(payload, secret, { expiresIn: '7d' });
  }
}
