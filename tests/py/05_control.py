n = 15
for i in range(1, n + 1):
    if i % 15 == 0:
        print("FizzBuzz")
    elif i % 3 == 0:
        print("Fizz")
    elif i % 5 == 0:
        print("Buzz")
    else:
        print(i)
i = 10
while i > 0 and not i == 3:
    i -= 1
    if i == 7:
        continue
    if i == 2: break
print("i =", i)
for k in range(10, 0, -3):
    print(k, end=" ")
print()
